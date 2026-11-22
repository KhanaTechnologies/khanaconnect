import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorBox, Loading } from '../components/Status';
import { money } from '../format';
import { useAsync } from '../useAsync';

export default function Services() {
  const state = useAsync(() => api('listServices'), []);
  return (
    <>
      <h1>Book a service</h1>
      {state.loading && <Loading />}
      {state.error && <ErrorBox message={state.error} />}
      {state.data && !state.data.services.length && <p className="muted">No services are open for booking yet.</p>}
      <div className="grid grid--3">
        {state.data?.services.map((s) => (
          <article key={s._id} className="card service-card">
            {s.image && <img src={s.image} alt="" loading="lazy" />}
            <h3>{s.name}</h3>
            {s.description && <p>{s.description}</p>}
            <p className="muted">
              {s.duration} min · {money(s.price)}
            </p>
            <Link className="btn" to={`/book?service=${encodeURIComponent(s._id)}`}>
              Choose a time
            </Link>
          </article>
        ))}
      </div>
    </>
  );
}
