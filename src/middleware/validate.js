/**
 * Validate and REPLACE the request part with the parsed result, so handlers
 * downstream see coerced, stripped values rather than raw strings.
 *
 * Zod errors are thrown, not caught — the error handler renders them as 422.
 */
export function validate({ body, params, query }) {
  return (req, _res, next) => {
    if (body) req.body = body.parse(req.body);
    if (params) req.validatedParams = params.parse(req.params);
    // req.query is a getter-only property in Express 5; assign to a new field.
    if (query) req.validatedQuery = query.parse(req.query);
    next();
  };
}
