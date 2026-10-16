"use client";
import { useParams } from "next/navigation";
import ConsolidationSheet from "../sheet";

export default function LegDetailPage() {
  const params = useParams<{ id: string }>();
  return <ConsolidationSheet id={params.id} />;
}
