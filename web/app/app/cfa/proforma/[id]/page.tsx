"use client";
import { useParams } from "next/navigation";
import ProformaGenerator from "../generator";

export default function ProformaDetailPage() {
  const params = useParams<{ id: string }>();
  return <ProformaGenerator id={params.id} />;
}
