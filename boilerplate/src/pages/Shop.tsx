import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { ProductCard } from '../components/ProductCard';
import { ErrorBox, Loading } from '../components/Status';
import { useAsync } from '../useAsync';

export default function Shop() {
  const [params, setParams] = useSearchParams();
  const category = params.get('category') || '';
  const q = params.get('q') || '';
  const cats = useAsync(() => api('listCategories'), []);
  const state = useAsync(
    () => api('listProducts', { query: { category: category || undefined, q: q || undefined } }),
    [category, q],
  );

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <>
      <h1>Shop</h1>
      <div className="filters">
        <input
          type="search"
          placeholder="Search products"
          defaultValue={q}
          onChange={(e) => set('q', e.target.value)}
          aria-label="Search products"
        />
        <select value={category} onChange={(e) => set('category', e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {cats.data?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {state.loading && <Loading />}
      {state.error && <ErrorBox message={state.error} />}
      {state.data && !state.data.products.length && <p className="muted">No products found.</p>}
      <div className="grid">
        {state.data?.products.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
    </>
  );
}
