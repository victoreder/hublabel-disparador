/**
 * Entrypoint exigido pelo builder da Vercel (modo Web Service / Node).
 * Rotas reais: api/* (serverless) e public/* (estatico), via vercel.json.
 */
module.exports = (req, res) => {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Not Found");
};
