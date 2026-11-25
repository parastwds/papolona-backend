const db = require('../../db');
const ApiError = require('../../utils/ApiError');

async function getActive() {
  const q = await db.questionnaires.findActive();
  if (!q)
    throw ApiError.notFound(
      'QUESTIONNAIRE_NOT_FOUND',
      'The questionnaire is not available right now.',
    );
  return q;
}

/** Public shape: weights, readiness, tags and tie-break rules are never sent to the app. */
async function getActivePublic() {
  const q = await getActive();
  return {
    version: q.version,
    showCohortToUser: q.showCohortToUser,
    questions: q.questions.map((question) => ({
      key: question.key,
      prompt: question.prompt,
      multiple: !!question.multiple,
      options: question.options.map((o) => ({
        key: o.key,
        label: o.label,
        exclusive: !!o.exclusive,
      })),
    })),
  };
}

/** Accepts `optionKey` (single) or `optionKeys` (multi) and returns `{ questionKey, optionKeys }`. */
const normalizeAnswers = (answers) =>
  answers.map((a) => ({
    questionKey: a.questionKey,
    optionKeys: a.optionKeys ?? (a.optionKey ? [a.optionKey] : []),
  }));

// Split points (e.g. 3 / 3 options) are rounded so floating-point noise cannot break or create ties.
const round = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Pure scoring function (exported for unit tests). Expects normalized answers.
 * - Cohort: each chosen option adds its weights; on a multi-select question the points are split
 *   between the chosen options, so ticking everything does not boost every cohort.
 * - Ties: more points from `tieBreakQuestions` wins, then `tieBreak` order, then cohort order.
 * - Readiness: sum of option readiness (capped per question), mapped to the first tier reached.
 * - Tags: every chosen cxcxoption's tag.
 */
function score(questionnaire, answers) {
  const totals = Object.fromEntries(questionnaire.cohorts.map((c) => [c.key, 0]));
  const tieTotals = Object.fromEntries(questionnaire.cohorts.map((c) => [c.key, 0]));
  const tieQuestions = new Set(questionnaire.tieBreakQuestions ?? []);
  let readinessScore = 0;
  const tags = [];

  for (const question of questionnaire.questions) {
    const chosenKeys = answers.find((a) => a.questionKey === question.key)?.optionKeys ?? [];
    const chosen = question.options.filter((o) => chosenKeys.includes(o.key));
    if (!chosen.length) continue;

    const share = question.multiple ? 1 / chosen.length : 1;
    let questionReadiness = 0;
    for (const option of chosen) {
      for (const w of option.weights ?? []) {
        if (!(w.cohort in totals)) continue;
        totals[w.cohort] += w.points * share;
        if (tieQuestions.has(question.key)) tieTotals[w.cohort] += w.points * share;
      }
      questionReadiness += option.readiness ?? 0;
      if (option.tag) tags.push(option.tag);
    }
    readinessScore +=
      question.readinessCap == null
        ? questionReadiness
        : Math.min(questionReadiness, question.readinessCap);
  }

  for (const k of Object.keys(totals)) {
    totals[k] = round(totals[k]);
    tieTotals[k] = round(tieTotals[k]);
  }

  const max = Math.max(...Object.values(totals));
  const tied = Object.keys(totals).filter((k) => totals[k] === max);
  const tieMax = Math.max(...tied.map((k) => tieTotals[k]));
  const finalists = tied.filter((k) => tieTotals[k] === tieMax);
  const order = [...(questionnaire.tieBreak ?? []), ...questionnaire.cohorts.map((c) => c.key)];
  const cohort = order.find((k) => finalists.includes(k));

  const tiers = questionnaire.readinessTiers ?? [];
  const readinessTier = tiers.length
    ? (tiers.find((t) => readinessScore >= t.minScore) ?? tiers[tiers.length - 1]).key
    : null;

  return {
    cohort,
    scores: Object.entries(totals).map(([c, s]) => ({ cohort: c, score: s })),
    readinessScore: tiers.length ? readinessScore : null,
    readinessTier,
    tags,
  };
}

function checkAnswers(questionnaire, answers) {
  const seen = new Set();
  const details = [];

  for (const a of answers) {
    const question = questionnaire.questions.find((q) => q.key === a.questionKey);
    if (seen.has(a.questionKey))
      details.push({ field: a.questionKey, message: 'Question answered more than once.' });
    seen.add(a.questionKey);
    if (!question) {
      details.push({ field: a.questionKey, message: 'Unknown question.' });
      continue;
    }

    const options = a.optionKeys.map((key) => question.options.find((o) => o.key === key));
    if (!a.optionKeys.length)
      details.push({ field: a.questionKey, message: 'This question has not been answered.' });
    else if (options.some((o) => !o))
      details.push({ field: a.questionKey, message: 'Unknown option for this question.' });
    else if (new Set(a.optionKeys).size !== a.optionKeys.length)
      details.push({ field: a.questionKey, message: 'The same option was chosen more than once.' });
    else if (!question.multiple && a.optionKeys.length > 1)
      details.push({ field: a.questionKey, message: 'Choose only one option for this question.' });
    else if (a.optionKeys.length > 1 && options.some((o) => o.exclusive))
      details.push({
        field: a.questionKey,
        message: `"${options.find((o) => o.exclusive).label}" cannot be combined with other options.`,
      });
  }
  for (const q of questionnaire.questions) {
    if (!seen.has(q.key))
      details.push({ field: q.key, message: 'This question has not been answered.' });
  }

  if (details.length)
    throw ApiError.badRequest('INVALID_ANSWERS', 'Please answer every question.', details);
}

async function submit({ version, answers: rawAnswers, deviceId }, meta) {
  const questionnaire = await getActive();
  if (version !== questionnaire.version) {
    throw ApiError.conflict(
      'QUESTIONNAIRE_OUTDATED',
      'The questionnaire has been updated. Please start again.',
    );
  }
  const answers = normalizeAnswers(rawAnswers);
  checkAnswers(questionnaire, answers);

  const { cohort, scores, readinessScore, readinessTier, tags } = score(questionnaire, answers);
  const submission = await db.submissions.create({
    questionnaireId: questionnaire.id,
    questionnaireVersion: questionnaire.version,
    answers,
    scores,
    cohort,
    readinessScore,
    readinessTier,
    tags,
    deviceId: deviceId ?? null,
    ip: meta.ip,
  });

  const details = questionnaire.cohorts.find((c) => c.key === cohort);
  return {
    submissionId: submission.id,
    showCohortToUser: questionnaire.showCohortToUser,
    cohort: questionnaire.showCohortToUser
      ? { key: details.key, name: details.name, description: details.description }
      : null,
  };
}

/** Cohort details for a user, respecting the visibility flag of the version they answered. */
async function cohortForUser(user) {
  if (!user.questionnaireSubmission) return null;
  const submission = await db.submissions.findById(user.questionnaireSubmission);
  if (!submission) return null;
  const q = await db.questionnaires.findById(submission.questionnaireId);
  if (!q?.showCohortToUser) return null;
  const c = q.cohorts.find((x) => x.key === user.cohort);
  return c ? { key: c.key, name: c.name, description: c.description } : null;
}

module.exports = { getActivePublic, submit, score, normalizeAnswers, cohortForUser };
