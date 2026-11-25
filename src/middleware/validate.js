/**
 * Validates req.body / req.params / req.query against Zod schemas.
 * Parsed (and stripped) values replace the originals, so controllers only
 * ever see known fields. This also blocks operator-style injection such as
 * { "email": { "$gt": "" } } because fields must match their declared types.
 */
const validate = (schemas) => (req, _res, next) => {
  if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
  if (schemas.params) req.validatedParams = schemas.params.parse(req.params);
  if (schemas.query) req.validatedQuery = schemas.query.parse(req.query);
  next();
};

module.exports = validate;
