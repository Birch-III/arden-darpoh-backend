// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  console.error(err);

  if (err.code === '23505') {
    return res.status(409).json({ error: 'That record already exists (duplicate value).' });
  }
  if (err.code === '23503') {
    return res.status(409).json({ error: 'This action references a record that does not exist.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Uploaded file is too large.' });
  }

  res.status(err.status || 500).json({
    error: err.publicMessage || 'Something went wrong on the server.',
  });
};
