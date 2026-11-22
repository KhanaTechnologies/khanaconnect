import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api/client';
import { config } from '../config';
import { ErrorBox } from '../components/Status';
import { useSite } from '../SiteContext';

export default function Contact() {
  const { site } = useSite();
  const [state, setState] = useState<{ busy: boolean; sent?: string; error?: string }>({ busy: false });

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) || '').trim();
    setState({ busy: true });
    try {
      const res = await api('sendContact', {
        body: { name: v('name'), email: v('email'), phone: v('phone') || undefined, message: v('message'), hp_field: v('hp_field') },
      });
      setState({ busy: false, sent: res.message });
    } catch (err) {
      setState({ busy: false, error: errorMessage(err) });
    }
  }

  return (
    <div className="contact">
      <div>
        <h1>Contact {site.companyName}</h1>
        <ul className="contact__list">
          {config.contact.phone && (
            <li>
              Phone: <a href={`tel:${config.contact.phone.replace(/\s/g, '')}`}>{config.contact.phone}</a>
            </li>
          )}
          {config.contact.email && (
            <li>
              Email: <a href={`mailto:${config.contact.email}`}>{config.contact.email}</a>
            </li>
          )}
          {config.contact.address && <li>{config.contact.address}</li>}
          {site.whatsappChatUrl && (
            <li>
              <a href={site.whatsappChatUrl} target="_blank" rel="noreferrer">
                Chat on WhatsApp
              </a>
            </li>
          )}
        </ul>
      </div>
      {config.contact.showForm &&
        (state.sent ? (
          <p className="notice">{state.sent}</p>
        ) : (
          <form className="form card" onSubmit={submit}>
            <label className="field">
              Name
              <input name="name" required maxLength={120} autoComplete="name" />
            </label>
            <label className="field">
              Email
              <input name="email" type="email" required autoComplete="email" />
            </label>
            <label className="field">
              Phone (optional)
              <input name="phone" type="tel" autoComplete="tel" />
            </label>
            <label className="field">
              Message
              <textarea name="message" rows={5} required maxLength={5000} />
            </label>
            {/* Honeypot: hidden from people, bots fill it in and the API quietly drops the message. */}
            <input name="hp_field" tabIndex={-1} autoComplete="off" className="hp" aria-hidden="true" />
            {state.error && <ErrorBox message={state.error} />}
            <button className="btn" disabled={state.busy}>
              {state.busy ? 'Sending…' : 'Send message'}
            </button>
          </form>
        ))}
    </div>
  );
}
