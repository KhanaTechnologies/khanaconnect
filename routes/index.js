var express = require('express');
var router = express.Router();

/* Root / health check (Render probes HEAD /). No view engine is configured, so don't render. */
router.get('/', function(req, res) {
  res.json({ ok: true, service: 'khanaconnect' });
});

module.exports = router;
