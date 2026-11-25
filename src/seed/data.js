/**
 * Seed content. The questionnaire is v4: v3 (client-approved) with four cohorts instead of eight, as the
 * client asked on 2026-11-18. Creator – Revenue, Institution, Brand and Investor are gone, and with them the
 * gallery, brand and investor answers, so nothing reads as an investment offer. Brands and institutions can
 * contact the team instead. Story and legal text live in the app.
 * The cohort is internal only (showCohortToUser: false) so users cannot steer their recommendations.
 */

const w = (cohort, points) => ({ cohort, points });

const questionnaire = {
  version: 4,
  isActive: true,
  showCohortToUser: false,
  tieBreakQuestions: ['role', 'goal'],
  tieBreak: ['creator', 'collector', 'patron', 'explorer'],
  readinessTiers: [
    { key: 'high', minScore: 4 },
    { key: 'medium', minScore: 2 },
    { key: 'low', minScore: 0 },
  ],
  // One for each membership path after the apprenticeship (Creator, Collector, Explorer), and patrons, who
  // commission work.
  cohorts: [
    { key: 'creator', name: 'Creator', description: 'Artists seeking visibility, recognition or prestige for their work.' },
    { key: 'collector', name: 'Collector', description: 'Buyers looking to acquire artwork and Papolona NFTs.' },
    { key: 'patron', name: 'Patron', description: 'Individuals or organisations wanting work made for them.' },
    { key: 'explorer', name: 'Explorer', description: 'Curious visitors without a clear goal yet.' },
  ],
  questions: [
    {
      key: 'role',
      prompt: 'What best describes you?',
      options: [
        { key: 'artist', label: 'Artist / Creator', weights: [w('creator', 3)] },
        { key: 'collector', label: 'Collector', weights: [w('collector', 3), w('patron', 1)] },
        { key: 'patron', label: 'Patron / Commissioner', weights: [w('patron', 3), w('collector', 1)] },
        { key: 'other', label: 'Other', weights: [w('explorer', 2)] },
      ],
    },
    {
      key: 'goal',
      prompt: 'What are you hoping to achieve through Papolona art?',
      multiple: true,
      options: [
        { key: 'sell_nfts', label: 'Sell your NFTs created through Papolona', weights: [w('creator', 2)] },
        { key: 'exhibit_sell', label: 'Exhibit and sell your own artwork', weights: [w('creator', 2)] },
        { key: 'acquire', label: 'Acquire artwork', weights: [w('collector', 3)] },
        { key: 'commission', label: 'Commission work', weights: [w('patron', 3)] },
        { key: 'learn', label: 'Learn more', weights: [w('explorer', 3)] },
      ],
    },
    {
      key: 'outcome',
      prompt: 'What outcome matters most to you?',
      options: [
        { key: 'visibility', label: 'Visibility', weights: [w('creator', 2)] },
        { key: 'revenue', label: 'Revenue', weights: [w('creator', 2)] },
        { key: 'prestige', label: 'Prestige / recognition', weights: [w('creator', 1), w('patron', 1)] },
        { key: 'innovation', label: 'Innovation / experimentation', weights: [w('patron', 1), w('explorer', 1)] },
        { key: 'social_impact', label: 'Social impact', weights: [w('patron', 1), w('explorer', 1)] },
        { key: 'collection', label: 'Building a collection', weights: [w('collector', 2)] },
      ],
    },
    {
      key: 'timeline',
      prompt: 'How soon do you want to achieve this?',
      options: [
        { key: '1_3_months', label: '1–3 months', weights: [], readiness: 2 },
        { key: '3_12_months', label: '3–12 months', weights: [], readiness: 1 },
        { key: 'exploring', label: 'Just exploring', weights: [w('explorer', 2)], readiness: 0 },
      ],
    },
    {
      key: 'resources',
      prompt: 'What resources will you devote to pursuing the goal?',
      multiple: true,
      readinessCap: 2,
      options: [
        { key: 'budget', label: 'Budget', weights: [], readiness: 1 },
        { key: 'audience', label: 'Existing audience', weights: [], readiness: 1 },
        { key: 'portfolio', label: 'Existing inventory / portfolio', weights: [], readiness: 1 },
        { key: 'technical', label: 'Technical capacity', weights: [], readiness: 1 },
        { key: 'team', label: 'A team', weights: [], readiness: 1 },
        { key: 'none', label: 'None yet', weights: [], readiness: 0, exclusive: true },
      ],
    },
    {
      key: 'engagement',
      prompt: 'How do you prefer to engage?',
      options: [
        { key: 'guided', label: 'Guided onboarding', weights: [], tag: 'engagement_guided' },
        { key: 'full_service', label: 'Full-service partnership', weights: [], tag: 'engagement_full_service' },
      ],
    },
    {
      key: 'risk',
      prompt: 'What is your risk tolerance?',
      options: [
        { key: 'conservative', label: 'Conservative', weights: [], tag: 'risk_conservative' },
        { key: 'balanced', label: 'Balanced', weights: [], tag: 'risk_balanced' },
        { key: 'experimental', label: 'Experimental', weights: [], tag: 'risk_experimental' },
      ],
    },
    {
      key: 'project',
      prompt: 'Do you already have a project in motion?',
      options: [
        { key: 'yes', label: 'Yes', weights: [], readiness: 2 },
        { key: 'planning', label: 'Planning phase', weights: [], readiness: 1 },
        { key: 'no', label: 'No', weights: [], readiness: 0 },
      ],
    },
  ],
};

const appConfig = {
  key: 'app',
  minSupportedVersion: { ios: '1.0.0', android: '1.0.0' },
  latestVersion: { ios: '1.0.0', android: '1.0.0' },
  storeUrls: { ios: '', android: '' },
  maintenance: { enabled: false, message: 'Papolona is being updated. Please try again shortly.' },
  supportEmail: 'support@papolona.com',
  // Bump when the Terms / Privacy text in the app changes; users who accepted an older version then re-accept.
  legal: { termsVersion: '1.0', privacyVersion: '1.0' },
};

module.exports = { questionnaire, appConfig };
