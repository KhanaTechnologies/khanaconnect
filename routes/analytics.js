const express = require("express");
const router = express.Router();
const NodeCache = require("node-cache");
const jwt = require("jsonwebtoken");
const Client = require("../models/client"); // Assuming you have a Client model
const gaClient = require("../helpers/gaClient");
const cache = new NodeCache({ stdTTL: 300 }); // 5 min cache

// ---------------- Middleware ---------------- //
const validateClient = (req, res, next) => {
    const token = req.headers.authorization;
    if (!token || !token.startsWith('Bearer ')) 
        return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });

    const tokenValue = token.split(' ')[1];
    jwt.verify(tokenValue, process.env.secret, (err, user) => {
        if (err || !user.clientID) return res.status(403).json({ error: 'Forbidden - Invalid token' });
        req.clientId = user.clientID;
        next();
    });
};

// ---------------- Helper: Aggregate Visits ---------------- //
const aggregateVisits = (rows, period) => {
    const map = {};
    rows.forEach(row => {
        const date = row.dimensionValues[0].value; // YYYYMMDD
        const year = date.substring(0, 4);
        const month = date.substring(4, 6);
        const day = date.substring(6, 8);

        let key;
        if (period === "weekly") {
            const firstDayOfYear = new Date(`${year}-01-01`);
            const currentDate = new Date(`${year}-${month}-${day}`);
            const week = Math.ceil(((currentDate - firstDayOfYear) / (7 * 24 * 60 * 60 * 1000)) + 1);
            key = `${year}-W${week}`;
        } else if (period === "monthly") {
            key = `${year}-${month}`;
        } else if (period === "yearly") {
            key = `${year}`;
        }

        if (!map[key]) map[key] = 0;
        map[key] += Number(row.metricValues[0].value);
    });

    return Object.keys(map)
        .sort()
        .map(k => ({ period: k, visits: map[k] }));
};

// ---------------- /overview Route ---------------- //
router.get("/overview", validateClient, async (req, res) => {
    try {
        const clientId = req.clientId;
        const cacheKey = `ga:${clientId}:overview`;

        // Return cached data if exists
        if (cache.has(cacheKey)) return res.json(cache.get(cacheKey));

        // Fetch client from DB to get GA4 Property ID
        const client = await Client.findOne({ clientID: clientId });
        console.log(client);
        if (!client || !client.ga4PropertyId) 
            return res.status(400).json({ error: "GA4 property ID not configured for this client" });

        const ga4PropertyId = client.ga4PropertyId;

        // Fetch GA data for last ~5 years (for weekly/monthly/yearly aggregation)
        const [response] = await gaClient.runReport({
            property: `properties/${ga4PropertyId}`,
            dateRanges: [{ startDate: "1825daysAgo", endDate: "today" }], // ~5 years
            dimensions: [
                { name: "sessionSource" },
                { name: "sessionMedium" },
                { name: "date" }
            ],
            metrics: [
                { name: "activeUsers" },
                { name: "sessions" },
                { name: "screenPageViews" },
                { name: "eventCount" },
                { name: "conversions" },
                { name: "averageSessionDuration" }
            ]
        });

        const rows = response.rows || [];

        // ---------------- Traffic Sources ---------------- //
        const trafficSourcesMap = {};
        rows.forEach(row => {
            const source = row.dimensionValues[0].value;
            const medium = row.dimensionValues[1].value;
            const key = `${source}::${medium}`;

            if (!trafficSourcesMap[key]) {
                trafficSourcesMap[key] = {
                    source,
                    medium,
                    activeUsers: 0,
                    sessions: 0,
                    pageViews: 0,
                    events: 0,
                    conversions: 0,
                    avgSessionDuration: 0
                };
            }

            trafficSourcesMap[key].activeUsers += Number(row.metricValues[0].value);
            trafficSourcesMap[key].sessions += Number(row.metricValues[1].value);
            trafficSourcesMap[key].pageViews += Number(row.metricValues[2].value);
            trafficSourcesMap[key].events += Number(row.metricValues[3].value);
            trafficSourcesMap[key].conversions += Number(row.metricValues[4].value);
            trafficSourcesMap[key].avgSessionDuration += Number(row.metricValues[5].value);
        });

        const trafficSources = Object.values(trafficSourcesMap).map(item => ({
            ...item,
            avgSessionDuration: item.sessions > 0
                ? (item.avgSessionDuration / item.sessions).toFixed(2)
                : 0
        }));

        // ---------------- Website Analytics ---------------- //
        const websiteAnalytics = trafficSources.reduce(
            (acc, cur) => {
                acc.activeUsers += cur.activeUsers;
                acc.sessions += cur.sessions;
                acc.pageViews += cur.pageViews;
                acc.events += cur.events;
                acc.conversions += cur.conversions;
                acc.avgSessionDuration += Number(cur.avgSessionDuration) * cur.sessions;
                return acc;
            },
            {
                activeUsers: 0,
                sessions: 0,
                pageViews: 0,
                events: 0,
                conversions: 0,
                avgSessionDuration: 0
            }
        );

        websiteAnalytics.avgSessionDuration = websiteAnalytics.sessions > 0
            ? (websiteAnalytics.avgSessionDuration / websiteAnalytics.sessions).toFixed(2)
            : 0;

        // ---------------- Weekly / Monthly / Yearly Visits ---------------- //
        const dailyRows = rows.map(r => ({
            dimensionValues: [r.dimensionValues[2]], // date
            metricValues: [r.metricValues[1]] // sessions
        }));

        const weeklyVisits = aggregateVisits(dailyRows, "weekly");
        const monthlyVisits = aggregateVisits(dailyRows, "monthly");
        const yearlyVisits = aggregateVisits(dailyRows, "yearly");

        const result = {
            trafficSources,
            websiteAnalytics,
            visits: { weekly: weeklyVisits, monthly: monthlyVisits, yearly: yearlyVisits }
        };

        cache.set(cacheKey, result);
        res.json(result);

    } catch (err) {
        console.error("GA ERROR:", err.message);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
