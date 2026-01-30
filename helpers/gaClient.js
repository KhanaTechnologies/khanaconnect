const { BetaAnalyticsDataClient } = require("@google-analytics/data");

const gaClient = new BetaAnalyticsDataClient({
  keyFilename: "/etc/secrets/khanaconnect-484716-842b641963bf.json"
});

module.exports = gaClient;
