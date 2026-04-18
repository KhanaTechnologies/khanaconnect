const Customer = require('../models/customer');
const Product = require('../models/product');
const { OrderItem } = require('../models/orderItem');

/**
 * Update customer order history and shopping habits (shared after successful payment).
 */
async function updateCustomerOrderHistory(customerId, order, orderItems) {
  try {
    const customer = await Customer.findById(customerId);
    if (!customer) return;

    const populatedOrderItems = await Promise.all(
      orderItems.map(async (item) => {
        const product = await Product.findById(item.product).select('productName images category');
        const orderItem = await OrderItem.findById(item._id || item);

        return {
          productId: item.product,
          productName: product?.productName || 'Unknown Product',
          quantity: item.quantity,
          price: orderItem?.variantPrice || product?.price || 0,
          image: product?.images?.[0] || '',
          category: product?.category?.name || '',
          variant: orderItem?.variant || {},
        };
      })
    );

    customer.orderHistory.push({
      orderId: order._id.toString(),
      products: populatedOrderItems,
      totalAmount: order.finalPrice,
      orderDate: order.dateOrdered,
      status: order.status,
    });

    customer.totalOrders += 1;
    customer.totalSpent += order.finalPrice;
    customer.lastActivity = new Date();

    if (!customer.preferences.shoppingHabits) {
      customer.preferences.shoppingHabits = {
        averageOrderValue: 0,
        favoriteProducts: [],
        typicalOrderInterval: 0,
        lastOrderDate: null,
      };
    }

    const now = new Date();
    if (customer.preferences.shoppingHabits.lastOrderDate) {
      const lastOrder = new Date(customer.preferences.shoppingHabits.lastOrderDate);
      const daysBetween = (now - lastOrder) / (1000 * 60 * 60 * 24);

      if (customer.preferences.shoppingHabits.typicalOrderInterval) {
        customer.preferences.shoppingHabits.typicalOrderInterval =
          (customer.preferences.shoppingHabits.typicalOrderInterval + daysBetween) / 2;
      } else {
        customer.preferences.shoppingHabits.typicalOrderInterval = daysBetween;
      }
    }
    customer.preferences.shoppingHabits.lastOrderDate = now;

    customer.preferences.shoppingHabits.averageOrderValue = customer.totalSpent / customer.totalOrders;

    populatedOrderItems.forEach((product) => {
      if (!customer.preferences.shoppingHabits.favoriteProducts.includes(product.productId)) {
        customer.preferences.shoppingHabits.favoriteProducts.push(product.productId);
      }
    });

    const categoryCount = {};
    populatedOrderItems.forEach((product) => {
      if (product.category) {
        categoryCount[product.category] = (categoryCount[product.category] || 0) + 1;
      }
    });

    customer.preferences.favoriteCategories = Object.entries(categoryCount)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([category]) => category);

    customer.cart = [];

    await customer.save();
    console.log(`✅ Updated order history for customer ${customer.customerFirstName} ${customer.customerLastName}`);
  } catch (error) {
    console.error('Error updating customer order history:', error);
  }
}

module.exports = { updateCustomerOrderHistory };
