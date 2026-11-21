export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <p className="status" role="status">
      {label}
    </p>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <p className="status status--error" role="alert">
      {message}
    </p>
  );
}
