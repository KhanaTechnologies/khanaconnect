const mongoose = require('mongoose');
const Customer = require('../models/customer');
const Client = require('../models/client');
require('dotenv').config();

async function encryptExistingCustomers() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const clients = await Client.find({});
    
    for (const client of clients) {
      console.log(`\nProcessing customers for client: ${client.clientID}`);
      
      const customers = await Customer.find({ clientID: client.clientID });
      console.log(`Found ${customers.length} customers`);

      for (const customer of customers) {
        let modified = false;

        // Check each field and encrypt if not already encrypted
        if (customer.emailAddress && !customer.emailAddress.includes(':')) {
          customer.emailAddress = customer.emailAddress; // Trigger setter
          modified = true;
        }

        if (customer.phoneNumber && customer.phoneNumber.toString && !customer.phoneNumber.toString().includes(':')) {
          customer.phoneNumber = customer.phoneNumber; // Trigger setter
          modified = true;
        }

        if (customer.address && !customer.address.includes(':')) {
          customer.address = customer.address; // Trigger setter
          modified = true;
        }

        if (customer.city && !customer.city.includes(':')) {
          customer.city = customer.city; // Trigger setter
          modified = true;
        }

        if (customer.postalCode && !customer.postalCode.includes(':')) {
          customer.postalCode = customer.postalCode; // Trigger setter
          modified = true;
        }

        if (modified) {
          await customer.save();
          console.log(`  - Encrypted customer: ${customer.emailAddress}`);
        }
      }
    }

    console.log('\nCustomer encryption migration completed');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

encryptExistingCustomers();