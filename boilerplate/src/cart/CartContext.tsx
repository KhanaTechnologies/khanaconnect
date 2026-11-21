import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { StorefrontProduct } from '../api/client';

/**
 * Cart lives in the browser (localStorage). Prices shown here are for display only:
 * the API re-prices every line when the order is created.
 */
export interface CartLine {
  productId: string;
  name: string;
  image: string | null;
  unitPrice: number;
  quantity: number;
  variant?: { name: string; value: string };
}

const KEY = 'khana:cart';
const lineKey = (l: Pick<CartLine, 'productId' | 'variant'>) => `${l.productId}|${l.variant?.name ?? ''}|${l.variant?.value ?? ''}`;

interface CartApi {
  lines: CartLine[];
  count: number;
  subtotal: number;
  add(product: StorefrontProduct, quantity: number, variant?: { name: string; value: string }): void;
  setQuantity(key: string, quantity: number): void;
  remove(key: string): void;
  clear(): void;
  keyOf: typeof lineKey;
}

const CartContext = createContext<CartApi | null>(null);

function load(): CartLine[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CartLine[]) : [];
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(lines));
    } catch {
      /* storage unavailable: cart still works for this visit */
    }
  }, [lines]);

  const value = useMemo<CartApi>(() => {
    const upsert = (line: CartLine) =>
      setLines((prev) => {
        const k = lineKey(line);
        const found = prev.find((l) => lineKey(l) === k);
        if (!found) return [...prev, line];
        return prev.map((l) => (lineKey(l) === k ? { ...l, quantity: Math.min(99, l.quantity + line.quantity) } : l));
      });
    return {
      lines,
      count: lines.reduce((n, l) => n + l.quantity, 0),
      subtotal: Math.round(lines.reduce((n, l) => n + l.unitPrice * l.quantity, 0) * 100) / 100,
      add(product, quantity, variant) {
        const vPrice = variant
          ? product.variants.find((v) => v.name === variant.name)?.values.find((x) => x.value === variant.value)?.unitPrice
          : undefined;
        upsert({
          productId: product.id,
          name: product.name,
          image: product.images[0] ?? null,
          unitPrice: vPrice ?? product.unitPrice,
          quantity,
          variant,
        });
      },
      setQuantity(key, quantity) {
        setLines((prev) =>
          prev.map((l) => (lineKey(l) === key ? { ...l, quantity: Math.max(1, Math.min(99, quantity)) } : l)),
        );
      },
      remove(key) {
        setLines((prev) => prev.filter((l) => lineKey(l) !== key));
      },
      clear() {
        setLines([]);
      },
      keyOf: lineKey,
    };
  }, [lines]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartApi {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart outside CartProvider');
  return ctx;
}
