const { BetaAnalyticsDataClient } = require("@google-analytics/data");

const gaClient = new BetaAnalyticsDataClient({
  credentials: JSON.parse(process.env.GA_SERVICE_ACCOUNT_JSON)
});

module.exports = gaClient;
