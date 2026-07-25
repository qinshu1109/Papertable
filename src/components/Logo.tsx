export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-label="纸桌 Papertable"
      role="img"
    >
      <path
        d="M7 22.5V10a2.5 2.5 0 0 1 2.5-2.5h6.2l4.8 4.8v10.2a2.5 2.5 0 0 1-2.5 2.5H9.5A2.5 2.5 0 0 1 7 22.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M11 19h6M11 15.5h4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <circle cx="23.2" cy="9.4" r="3.4" fill="var(--accent)" />
    </svg>
  );
}
