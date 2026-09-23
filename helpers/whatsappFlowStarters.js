/**
 * Static WhatsApp Flow JSON starters (no endpoint required).
 * Meta Flow JSON version 5.0+ with terminal complete screens.
 */

function appointmentBookingFlowJson(businessName = 'us') {
  const brand = String(businessName || 'us').slice(0, 60);
  return {
    version: '7.3',
    screens: [
      {
        id: 'BOOKING',
        title: 'Book with us',
        terminal: true,
        success: true,
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextHeading', text: `Book with ${brand}` },
            {
              type: 'TextBody',
              text: 'Tell us who you are and when you prefer. We will confirm shortly.',
            },
            {
              type: 'Form',
              name: 'booking_form',
              children: [
                {
                  type: 'TextInput',
                  name: 'full_name',
                  label: 'Your name',
                  required: true,
                  'input-type': 'text',
                },
                {
                  type: 'TextInput',
                  name: 'preferred_day',
                  label: 'Preferred day (e.g. Tue 22 Sep)',
                  required: true,
                  'input-type': 'text',
                },
                {
                  type: 'TextInput',
                  name: 'preferred_time',
                  label: 'Preferred time',
                  required: true,
                  'input-type': 'text',
                },
                {
                  type: 'TextArea',
                  name: 'notes',
                  label: 'Notes (optional)',
                  required: false,
                },
                {
                  type: 'Footer',
                  label: 'Submit booking',
                  'on-click-action': {
                    name: 'complete',
                    payload: {
                      full_name: '${form.full_name}',
                      preferred_day: '${form.preferred_day}',
                      preferred_time: '${form.preferred_time}',
                      notes: '${form.notes}',
                      flow_type: 'appointment_booking',
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

function leadGenerationFlowJson(businessName = 'us') {
  const brand = String(businessName || 'us').slice(0, 60);
  return {
    version: '7.3',
    screens: [
      {
        id: 'LEAD',
        title: 'Get in touch',
        terminal: true,
        success: true,
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextHeading', text: `Talk to ${brand}` },
            {
              type: 'TextBody',
              text: 'Share your details and we will follow up.',
            },
            {
              type: 'Form',
              name: 'lead_form',
              children: [
                {
                  type: 'TextInput',
                  name: 'full_name',
                  label: 'Your name',
                  required: true,
                  'input-type': 'text',
                },
                {
                  type: 'TextInput',
                  name: 'email',
                  label: 'Email',
                  required: false,
                  'input-type': 'text',
                },
                {
                  type: 'TextInput',
                  name: 'interest',
                  label: 'What are you interested in?',
                  required: true,
                  'input-type': 'text',
                },
                {
                  type: 'Footer',
                  label: 'Send',
                  'on-click-action': {
                    name: 'complete',
                    payload: {
                      full_name: '${form.full_name}',
                      email: '${form.email}',
                      interest: '${form.interest}',
                      flow_type: 'lead_generation',
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

function contactUsFlowJson(businessName = 'us') {
  const brand = String(businessName || 'us').slice(0, 60);
  return {
    version: '7.3',
    screens: [
      {
        id: 'CONTACT',
        title: 'Message us',
        terminal: true,
        success: true,
        data: {},
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextHeading', text: `Message ${brand}` },
            {
              type: 'Form',
              name: 'contact_form',
              children: [
                {
                  type: 'TextInput',
                  name: 'full_name',
                  label: 'Your name',
                  required: true,
                  'input-type': 'text',
                },
                {
                  type: 'TextArea',
                  name: 'message',
                  label: 'How can we help?',
                  required: true,
                },
                {
                  type: 'Footer',
                  label: 'Send message',
                  'on-click-action': {
                    name: 'complete',
                    payload: {
                      full_name: '${form.full_name}',
                      message: '${form.message}',
                      flow_type: 'contact_us',
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

function listFlowStarters(businessName = 'Business') {
  return [
    {
      id: 'appointment_booking',
      name: 'Khana Appointment Booking',
      category: 'APPOINTMENT_BOOKING',
      description: 'Collect name, preferred day/time, and notes for a booking request.',
      cta: 'Book now',
      body: 'Tap below to pick a time that works for you.',
      flow_json: appointmentBookingFlowJson(businessName),
    },
    {
      id: 'lead_generation',
      name: 'Khana Lead Capture',
      category: 'LEAD_GENERATION',
      description: 'Capture name, email, and interest from WhatsApp.',
      cta: 'Get started',
      body: 'Share a few details and we will get back to you.',
      flow_json: leadGenerationFlowJson(businessName),
    },
    {
      id: 'contact_us',
      name: 'Khana Contact Us',
      category: 'CONTACT_US',
      description: 'Simple contact form inside WhatsApp.',
      cta: 'Message us',
      body: 'Send us a message — we are here to help.',
      flow_json: contactUsFlowJson(businessName),
    },
  ];
}

function getFlowStarter(id, businessName) {
  const key = String(id || '').trim().toLowerCase();
  return listFlowStarters(businessName).find((s) => s.id === key) || null;
}

module.exports = {
  listFlowStarters,
  getFlowStarter,
  appointmentBookingFlowJson,
  leadGenerationFlowJson,
  contactUsFlowJson,
};
