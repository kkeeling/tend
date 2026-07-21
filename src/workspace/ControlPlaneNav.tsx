import { Link } from "@tanstack/react-router";

export function ControlPlaneNav({ active }: { active: "now" | "coverage" | "ledger" }) {
  return (
    <nav className="control-nav" aria-label="Tend workspace">
      <Link className="control-brand" to="/now">Tend</Link>
      <Link className={active === "now" ? "active" : ""} to="/now">Now</Link>
      <Link to="/feed/$feedId" params={{ feedId: "inbox" }}>All feeds</Link>
      <Link className={active === "coverage" ? "active" : ""} to="/coverage">Coverage</Link>
      <Link className={active === "ledger" ? "active" : ""} to="/priority-ledger">Priority Ledger</Link>
    </nav>
  );
}
