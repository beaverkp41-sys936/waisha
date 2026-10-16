import {
  BookOpenText, Building2, Calculator, CalendarClock, ChartColumn, ClipboardCheck,
  ContactRound, FileSignature, Fuel, IdCard, KeyRound, LayoutDashboard, MapPinned,
  Megaphone, MessageSquare, Navigation, Package, Receipt, ReceiptText, Route, Settings,
  ShieldCheck, TriangleAlert, Truck, Users, UsersRound, Wallet
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
  { href: "/app/account", label: "Account", icon: Settings }
];

export const CFA_NAV: NavItem[] = [
  { href: "/app/cfa", label: "Overview", icon: LayoutDashboard },
  { href: "/app/cfa/cargo", label: "Cargo files", icon: BookOpenText },
  { href: "/app/cfa/jobs", label: "Job pipeline", icon: ClipboardCheck },
  { href: "/app/cfa/invoices", label: "Invoices", icon: Receipt },
  { href: "/app/cfa/proforma", label: "Proforma & quotes", icon: ReceiptText },
  { href: "/app/cfa/ledger", label: "Ledger", icon: ChartColumn },
  { href: "/app/documents", label: "Documents", icon: FileSignature },
  { href: "/app/cfa/duty", label: "Duty calculator", icon: Calculator },
  { href: "/app/cfa/messages", label: "Messages", icon: MessageSquare },
  { href: "/app/cfa/calendar", label: "ETA calendar", icon: CalendarClock },
  { href: "/app/cfa/compliance", label: "Compliance", icon: ShieldCheck }
];

export const OFFICE_NAV: NavItem[] = [
  { href: "/app/office", label: "Overview", icon: LayoutDashboard },
  { href: "/app/office/employees", label: "Employees", icon: UsersRound },
  { href: "/app/office/costs", label: "Office costs", icon: Wallet }
];
