/** The short Blue rule under each landing section title (ux §5.4). Decorative, one colour, never a band. TG-49: the lift
 * token, so it lightens on the dark page instead of vanishing. */
export default function SectionStripe() {
  return <div aria-hidden="true" className="mt-1 h-[3px] w-12 bg-lift" />;
}
