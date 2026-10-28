/** The ▶ menu cursor as an inline SVG in currentColor, so it follows the text colour in both themes (ux.md 5.2). */
export function MenuCursor({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 8 8"
      width="8"
      height="8"
      shapeRendering="crispEdges"
      className={className}
      fill="currentColor"
    >
      <path d="M2 0h1v8H2zM3 1h1v6H3zM4 2h1v4H4zM5 3h1v2H5z" />
    </svg>
  );
}
