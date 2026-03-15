const sizeLimiter = (maxEvents) => {
  return (req, res, next) => {
    const { events } = req.body;
    
    if (!events || !Array.isArray(events)) {
      return res.status(400).json({
        error: 'Invalid request body. Expected { events: [...] }'
      });
    }

    if (events.length > maxEvents) {
      return res.status(413).json({
        error: `Too many events. Maximum allowed: ${maxEvents}`
      });
    }

    if (events.length === 0) {
      return res.status(400).json({
        error: 'Events array cannot be empty'
      });
    }

    next();
  };
};

module.exports = sizeLimiter;