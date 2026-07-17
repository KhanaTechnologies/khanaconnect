const fs = require('fs').promises;
const path = require('path');
const Client = require('../models/client');
const Product = require('../models/product');
const { Category } = require('../models/category');
const { Order } = require('../models/order');
const { OrderItem } = require('../models/orderItem');
const Customer = require('../models/customer');
const Booking = require('../models/booking');
const Staff = require('../models/staff');
const Service = require('../models/service');
const { SalesItem } = require('../models/salesItem');
const DiscountCode = require('../models/discountCode');
const EmailSubscriber = require('../models/emailSubscriber');
const Email = require('../models/Email');
const NewsletterDraft = require('../models/NewsletterDraft');
const NewsletterOpen = require('../models/NewsletterOpen');
const CustomerSegment = require('../models/CustomerSegment');
const ProductBundle = require('../models/ProductBundle');
const B2BTier = require('../models/B2BTier');
const B2BBuyer = require('../models/B2BBuyer');
const B2BPriceList = require('../models/B2BPriceList');
const B2BLoginChallenge = require('../models/B2BLoginChallenge');
const B2BAuditLog = require('../models/B2BAuditLog');
const Warehouse = require('../models/Warehouse');
const WarehouseStock = require('../models/WarehouseStock');
const WarehouseLowStockAlert = require('../models/WarehouseLowStockAlert');
const TrackingEvent = require('../models/TrackingEvent');
const Resource = require('../models/resource');
const { Size } = require('../models/size');
const TeamMember = require('../models/teamMember');
const TeamActivity = require('../models/TeamActivity');
const WishList = require('../models/wishList');
const Waitlist = require('../models/waitlist');
const ServiceWishlistReminder = require('../models/serviceWishlistReminder');
const Subscriber = require('../models/subscribers');
const User = require('../models/user');
const Campaign = require('../models/Campaign');
const VotingCampaign = require('../models/VotingCampaign');
const PreorderPledge = require('../models/PreorderPledge');
const Vote = require('../models/Vote');
const AdvertisingPeriod = require('../models/AdvertisingPeriod');

async function tryDeleteEmailLogo(client) {
  if (!client?.emailLogoUrl) return;
  const match = String(client.emailLogoUrl).match(/\/public\/uploads\/email-logos\/([^/?#]+)/i);
  if (!match) return;
  const filePath = path.join(__dirname, '..', 'public', 'uploads', 'email-logos', match[1]);
  try {
    await fs.unlink(filePath);
  } catch {
    // File may already be gone
  }
}

async function deleteOrderItemsForClient(clientID) {
  const orders = await Order.find({ clientID }).select('orderItems').lean();
  const itemIds = orders.flatMap((order) => order.orderItems || []).filter(Boolean);
  if (!itemIds.length) return 0;
  const result = await OrderItem.deleteMany({ _id: { $in: itemIds } });
  return result.deletedCount || 0;
}

/**
 * Permanently remove a client and all tenant-scoped data.
 * @param {import('../models/client')} client Mongoose client document
 */
async function deleteAllClientData(client) {
  const clientID = client.clientID;
  const clientId = clientID;

  const orderItemsDeleted = await deleteOrderItemsForClient(clientID);

  const deletions = await Promise.all([
    Order.deleteMany({ clientID }),
    Product.deleteMany({ clientID }),
    Category.deleteMany({ clientID }),
    Customer.deleteMany({ clientID }),
    Booking.deleteMany({ clientID }),
    Staff.deleteMany({ clientID }),
    Service.deleteMany({ clientID }),
    SalesItem.deleteMany({ clientID }),
    DiscountCode.deleteMany({ clientID }),
    EmailSubscriber.deleteMany({ clientID }),
    Email.deleteMany({ clientID }),
    NewsletterDraft.deleteMany({ clientID }),
    NewsletterOpen.deleteMany({ clientID }),
    CustomerSegment.deleteMany({ clientID }),
    ProductBundle.deleteMany({ clientID }),
    B2BTier.deleteMany({ clientID }),
    B2BBuyer.deleteMany({ clientID }),
    B2BPriceList.deleteMany({ clientID }),
    B2BLoginChallenge.deleteMany({ clientID }),
    B2BAuditLog.deleteMany({ clientID }),
    WarehouseStock.deleteMany({ clientID }),
    WarehouseLowStockAlert.deleteMany({ clientID }),
    Warehouse.deleteMany({ clientID }),
    TrackingEvent.deleteMany({ clientID }),
    Resource.deleteMany({ clientID }),
    Size.deleteMany({ clientID }),
    TeamMember.deleteMany({ clientID }),
    TeamActivity.deleteMany({ clientID }),
    WishList.deleteMany({ clientID }),
    Waitlist.deleteMany({ clientID }),
    ServiceWishlistReminder.deleteMany({ clientID }),
    Subscriber.deleteMany({ clientID }),
    User.deleteMany({ clientID }),
    Campaign.deleteMany({ clientId }),
    VotingCampaign.deleteMany({ clientId }),
    PreorderPledge.deleteMany({ clientId }),
    Vote.deleteMany({ clientId }),
    AdvertisingPeriod.deleteMany({ clientID }),
  ]);

  await tryDeleteEmailLogo(client);
  await Client.deleteOne({ _id: client._id });

  const counts = {
    orderItems: orderItemsDeleted,
    orders: deletions[0].deletedCount || 0,
    products: deletions[1].deletedCount || 0,
    categories: deletions[2].deletedCount || 0,
    customers: deletions[3].deletedCount || 0,
    bookings: deletions[4].deletedCount || 0,
    staff: deletions[5].deletedCount || 0,
    services: deletions[6].deletedCount || 0,
    salesItems: deletions[7].deletedCount || 0,
    discountCodes: deletions[8].deletedCount || 0,
    emailSubscribers: deletions[9].deletedCount || 0,
    emails: deletions[10].deletedCount || 0,
    newsletterDrafts: deletions[11].deletedCount || 0,
    newsletterOpens: deletions[12].deletedCount || 0,
    customerSegments: deletions[13].deletedCount || 0,
    productBundles: deletions[14].deletedCount || 0,
    trackingEvents: deletions[15].deletedCount || 0,
    resources: deletions[16].deletedCount || 0,
    sizes: deletions[17].deletedCount || 0,
    teamMembers: deletions[18].deletedCount || 0,
    teamActivity: deletions[19].deletedCount || 0,
    wishLists: deletions[20].deletedCount || 0,
    waitlist: deletions[21].deletedCount || 0,
    serviceWishlistReminders: deletions[22].deletedCount || 0,
    subscribers: deletions[23].deletedCount || 0,
    users: deletions[24].deletedCount || 0,
    campaigns: deletions[25].deletedCount || 0,
    votingCampaigns: deletions[26].deletedCount || 0,
    preorderPledges: deletions[27].deletedCount || 0,
    votes: deletions[28].deletedCount || 0,
    advertisingPeriods: deletions[29].deletedCount || 0,
    clientID,
  };

  return counts;
}

module.exports = {
  deleteAllClientData,
};
