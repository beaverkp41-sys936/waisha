import {
  BookOpenText, Boxes, Building2, Calculator, CalendarCheck, CalendarClock, ChartColumn,
  ClipboardCheck, ContactRound, FileCheck2, FileSignature, Fuel, IdCard, KeyRound, LayoutDashboard,
  Lightbulb, MapPinned, Megaphone, MessageSquare, Navigation, Package, Receipt, ReceiptText, Route,
  Settings, ShieldCheck, TriangleAlert, Truck, Users, UsersRound, Wallet, Workflow
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

export const TRANSPORTER_NAV: NavItem[] = [
  { href: "/app/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/app/board", label: "Notice board", icon: Megaphone },
  { href: "/app/profile", label: "Profile", icon: Building2 },
  { href: "/app/branches", label: "Branches", icon: MapPinned },
  { href: "/app/fleet", label: "Fleet", icon: Truck },
  { href: "/app/routes", label: "Routes", icon: Route },
  { href: "/app/drivers", label: "Drivers", icon: ContactRound },
  { href: "/app/trips", label: "Trips", icon: Navigation },
  { href: "/app/fuel", label: "Fuel", icon: Fuel },
  { href: "/app/inventory", label: "Inventory", icon: Package },
  { href: "/app/incidents", label: "Incidents", icon: TriangleAlert },
  { href: "/app/clients", label: "Clients", icon: Users },
  { href: "/app/shipper-access", label: "Shipper access", icon: KeyRound },
  { href: "/app/compliance", label: "Compliance", icon: ShieldCheck },
  { href: "/app/reports", label: "Reports", icon: ChartColumn },
  { href: "/app/staff", label: "Staff", icon: IdCard },
  { href: "/app/recommendations", label: "Recommendations", icon: Lightbulb },
  { href: "/app/account", label: "Account", icon: Settings }
];

export const CFA_NAV: NavItem[] = [
  { href: "/app/cfa", label: "Overview", icon: LayoutDashboard },
  { href: "/app/cfa/cargo", label: "Cargo files", icon: BookOpenText },
  { href: "/app/cfa/jobs", label: "Job pipeline", icon: ClipboardCheck },
  { href: "/app/cfa/invoices", label: "Invoices", icon: Receipt },
  { href: "/app/cfa/proforma", label: "Proforma & quotes", icon: ReceiptText },
  { href: "/app/cfa/consolidation", label: "Consolidation", icon: Boxes },
  { href: "/app/cfa/ledger", label: "Ledger", icon: ChartColumn },
  { href: "/app/documents", label: "Documents", icon: FileSignature },
  { href: "/app/cfa/duty", label: "Duty calculator", icon: Calculator },
  { href: "/app/cfa/messages", label: "Messages", icon: MessageSquare },
  { href: "/app/cfa/calendar", label: "ETA calendar", icon: CalendarClock },
  { href: "/app/cfa/compliance", label: "Compliance", icon: ShieldCheck },
  { href: "/app/recommendations", label: "Recommendations", icon: Lightbulb }
];

export const OFFICE_NAV: NavItem[] = [
  { href: "/app/office", label: "Overview", icon: LayoutDashboard },
  { href: "/app/office/attendance", label: "Attendance", icon: CalendarCheck },
  { href: "/app/office/employees", label: "Employees", icon: UsersRound },
  { href: "/app/office/procedures", label: "Procedural flows", icon: Workflow },
  { href: "/app/office/reports", label: "Trainee reports", icon: FileCheck2 },
  { href: "/app/office/costs", label: "Office costs", icon: Wallet },
  { href: "/app/recommendations", label: "Recommendations", icon: Lightbulb }
];
