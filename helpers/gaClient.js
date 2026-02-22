// helpers/gaClient.js
const { BetaAnalyticsDataClient } = require("@google-analytics/data");
require('dotenv').config();

// Parse the JSON string from environment variable
let credentials;
try {
    credentials = JSON.parse(process.env.GA_SERVICE_ACCOUNT_JSON);
} catch (error) {
    console.error("Failed to parse GA_SERVICE_ACCOUNT_JSON:", error.message);
    throw new Error("Invalid GA service account JSON in environment variable");
}

const gaClient = new BetaAnalyticsDataClient({
    credentials: credentials,
    projectId: credentials.project_id || credentials.projectId
});

module.exports = gaClient;
