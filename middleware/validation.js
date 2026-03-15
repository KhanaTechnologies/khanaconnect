const validateBatchEvents = (req, res, next) => {
  const { events } = req.body;
  const errors = [];

  events.forEach((event, index) => {
    // Required fields validation
    if (!event.clientId) {
      errors.push(`Event ${index}: clientId is required`);
    }
    
    if (!event.sessionId) {
      errors.push(`Event ${index}: sessionId is required`);
    }
    
    if (!event.eventType) {
      errors.push(`Event ${index}: eventType is required`);
    }

    // Event type validation
    const validEventTypes = ['PAGE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART', 
                            'INITIATE_CHECKOUT', 'PURCHASE', 'LEAD'];
    
    if (event.eventType && !validEventTypes.includes(event.eventType)) {
      errors.push(`Event ${index}: invalid eventType. Must be one of: ${validEventTypes.join(', ')}`);
    }

    // Type validations
    if (event.clientId && typeof event.clientId !== 'string') {
      errors.push(`Event ${index}: clientId must be a string`);
    }

    if (event.metadata && typeof event.metadata !== 'object') {
      errors.push(`Event ${index}: metadata must be an object`);
    }
  });

  if (errors.length > 0) {
    return res.status(400).json({
      error: 'Validation failed',
      details: errors
    });
  }

  next();
};

module.exports = { validateBatchEvents };