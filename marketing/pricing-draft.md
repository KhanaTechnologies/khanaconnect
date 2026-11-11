# Khana pricing: simpler setup (draft, 7 Nov 2026)

Status: **draft for Jason to decide.** Nothing on the site has changed. Current live prices: Starter R450, Launch R650, Growth R899, Scale R1,799 per month, plus setup R1,999 to R14,999.

## Why change

- Four plans, seven add-ons, team seats and credit packs is a lot to explain to a salon owner, and Khana has no clients yet.
- Every plan already includes a store or bookings, which is the main thing people buy. So the upgrades are about pages, a blog and "Revenue Command Center", which owners don't ask for.
- R450 a month is about the price of a do-it-yourself builder, but Khana builds, hosts and supports it. One or two support requests a month use up the margin.
- The founding offer waives setup with no minimum term, so a client could leave in month 2 after a free build.

## The new plans

Name the plans after the kind of business, not the features. Every plan includes the same base.

**Every plan includes:**
- A website on your own domain, built by us (up to 8 pages)
- Your own business mailbox set up (Gmail, Microsoft 365 or your domain)
- WhatsApp Business connected: booking and order confirmations, reminders with Confirm / Reschedule buttons, order updates, and a WhatsApp to your phone for every new booking or order
- Customer list, orders or bookings dashboard
- Hosting, SSL, updates and backups
- WhatsApp and email support from the people who built it
- No commission on your sales

| | **Bookings** | **Shop** | **Shop + Bookings** |
|---|---|---|---|
| For | Salons, clinics, studios, trainers | Bakeries, boutiques, home businesses | Businesses that sell and book |
| Monthly | **R650** | **R650** | **R1,199** |
| Setup | R2,499 (or 6 × R417) | R2,499 (or 6 × R417) | R4,999 (or 6 × R834) |
| Extra in this plan | Staff calendars, services and durations, deposits | Products and stock, delivery or collection, cart recovery, promo codes | Everything in both |
| Content changes | 2 per month | 2 per month | 4 per month |

**Custom / larger organisations:** quoted (today's Enterprise, B2B trade ordering and custom systems stay as they are).

### What happens to the old plans
- Starter and Launch become Bookings or Shop.
- Growth and Scale become Shop + Bookings. The revenue tools (cart recovery, customer segments, promos) are included, not a separate tier.
- No clients are on the old plans, so nobody needs moving.

## Founding partner offer (5 spots)

> **No setup fee, and your monthly fee locked at R450 (Bookings or Shop) or R899 (Shop + Bookings) for 12 months, on a 12-month agreement.** In return, we ask for an honest review after 90 days and permission to share your results.

- The 12-month agreement is the change that matters. It covers the build cost: 12 × R450 = R5,400 against a normal R2,499 setup plus the work.
- If a founder wants to leave early, they pay the setup fee they skipped, less what they have already paid towards it. Put this in the terms.
- After the 12 months they move to the normal price, or stay at the founder price if Jason chooses. Decide now and say it up front.

## Add-ons (only the ones people understand)

| Add-on | Price | Notes |
|---|---|---|
| Facebook & Instagram ads, run for you | **R950/month** | We set up and run local ads. Meta bills the ad spend to your card directly. |
| Extra content changes | R350/month | 4 more changes a month |
| Large catalogue (500+ products) | R199/month | Same as today |
| Extra team logins | as today | Keep the existing seat pricing |
| Custom integration | from R2,000 once-off | Same as today |

Remove from the public page: Revenue Command Center add-on (now included), Advanced email campaigns (fold into Shop), Mixed business module (already hidden).

## WhatsApp messages and credits

- Say **"WhatsApp booking and order messages included"** on every plan, with a fair-use limit of 500 a month. Most of them already cost nothing: utility messages sent within 24 hours of the customer's last message are free from Meta. The rest cost Meta about R0.15 each, so 500 is roughly R75 at worst.
- Keep **credits** only for things the owner chooses to send: promo broadcasts (2.25 credits per message) and ad boosts. Keep the prepaid packs (R100 to R1,000) as they are.
- Drop "50/100/200/500 included credits that expire" from the plan cards. It makes owners do maths.

## Pay for a year upfront

- **Pay 10 months, get 12.** Bookings or Shop: R6,500 a year instead of R7,800.
- You get cash now, and clients who prepay rarely leave.

## What this could earn

| Scenario | Monthly income |
|---|---|
| 5 founders at R450 to R899 (all 12-month agreements) | about R2,700 (R32,400 committed over the year) |
| Then 10 normal clients at an average of R750, 3 of them adding ads at R950 | about R10,350 |
| Setup fees from those 10 clients | about R25,000 once-off (or spread over 6 months) |

## FAQ wording (ready to paste)

**How much does Khana cost?**
Bookings or Shop is R650 a month, and Shop + Bookings is R1,199. There's a once-off setup fee from R2,499 that you can split over 6 months. No commission on your sales.

**What's included?**
Your website on your own domain, your business mailbox, WhatsApp confirmations and reminders, your customer list, hosting, updates and support from the people who built it.

**Do WhatsApp messages cost extra?**
Booking and order messages are included (up to 500 a month). Promo broadcasts and ad boosts use prepaid credits, which you top up when you need them.

**Is there a contract?**
Month to month on normal plans, with one month's notice. Founding partner spots are a 12-month agreement because the setup fee is waived.

## To make it live (when you decide)

This needs a code change, not just the dashboard, because the backend only accepts plans called starter/launch/growth/scale/enterprise.
1. Backend: new tiers and add-ons in `helpers/partnershipPricingDefaults.js`, bump `PRICING_CONFIG_VERSION`, update the required tier list in `routes/partnershipPricing.js`, and check the quote builder (`routes/partnershipQuote.js`, `helpers/planBuilderPricing.js`) and the included credits per plan (`helpers/monthlyCreditAllowance.js`).
2. Terms: add the 12-month founding agreement and the early-exit rule to `helpers/legalPolicies.js`.
3. Dashboard and site: pricing page, comparison table and quote form in the frontend.
4. Marketing: update `social-post-brief.md` and the founding offer memory with the new names and prices.
