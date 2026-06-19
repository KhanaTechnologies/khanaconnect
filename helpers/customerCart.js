const Product = require('../models/product');

function normalizeVariant(variant) {
  if (!variant || typeof variant !== 'object') return {};
  return {
    name: variant.name || '',
    value: variant.value || '',
    price: Number(variant.price) || 0,
  };
}

async function findCustomerByEmail(Customer, clientID, normalizedEmail) {
  const customers = await Customer.find({ clientID });
  for (const c of customers) {
    if (c.emailAddress.toLowerCase() === normalizedEmail) {
      return c;
    }
  }
  return null;
}

async function computeCartLine(product, quantity, variant) {
  const v = normalizeVariant(variant);
  let availableStock = product.countInStock;

  if (v.name && product.variants && product.variants.length > 0) {
    const variantOption = product.variants.find((opt) => opt.name === v.name);
    if (variantOption) {
      const specificVariant = variantOption.values.find((val) => val.value === v.value);
      availableStock = specificVariant ? specificVariant.stock : product.countInStock;
    }
  }

  if (availableStock < quantity) {
    return { ok: false, error: 'Insufficient stock available', availableStock };
  }

  let finalPrice = product.price;
  if (v.price > 0) {
    finalPrice = v.price;
  } else if (v.name && product.variants && product.variants.length > 0) {
    const variantOption = product.variants.find((opt) => opt.name === v.name);
    if (variantOption) {
      const specificVariant = variantOption.values.find((val) => val.value === v.value);
      if (specificVariant?.price) finalPrice = specificVariant.price;
    }
  }

  if (product.salePercentage > 0) {
    finalPrice = finalPrice * (1 - product.salePercentage / 100);
  }

  return {
    ok: true,
    line: {
      productId: product._id,
      productName: product.productName,
      quantity,
      price: finalPrice,
      image: (product.images && product.images[0]) || '',
      category: product.category?.name || '',
      variant: v,
      addedAt: new Date(),
      lastAddedAt: new Date(),
    },
  };
}

async function upsertCartLine(customer, productId, quantity, variant, clientID) {
  const product = await Product.findOne({ _id: productId, clientID });
  if (!product) return { ok: false, error: 'Product not found' };

  const v = normalizeVariant(variant);
  const computed = await computeCartLine(product, quantity, v);
  if (!computed.ok) return computed;

  const existingIndex = customer.cart.findIndex(
    (item) =>
      item.productId.toString() === productId.toString() &&
      JSON.stringify(normalizeVariant(item.variant)) === JSON.stringify(v)
  );

  if (existingIndex > -1) {
    const newQuantity = customer.cart[existingIndex].quantity + quantity;
    const restockCheck = await computeCartLine(product, newQuantity, v);
    if (!restockCheck.ok) return restockCheck;
    customer.cart[existingIndex].quantity = newQuantity;
    customer.cart[existingIndex].lastAddedAt = new Date();
  } else {
    customer.cart.push(computed.line);
  }

  return { ok: true };
}

async function replaceCustomerCart(customer, items, clientID) {
  const nextCart = [];

  for (const raw of items || []) {
    const productId = raw.productId;
    const quantity = Number(raw.quantity) || 0;
    if (!productId || quantity < 1) continue;

    const product = await Product.findOne({ _id: productId, clientID });
    if (!product) continue;

    const computed = await computeCartLine(product, quantity, raw.variant);
    if (!computed.ok) continue;
    nextCart.push(computed.line);
  }

  customer.cart = nextCart;
  customer.lastActivity = new Date();
}

module.exports = {
  findCustomerByEmail,
  upsertCartLine,
  replaceCustomerCart,
  normalizeVariant,
};
