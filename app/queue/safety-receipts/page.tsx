import { redirect } from "next/navigation";
import { getDb } from "@/server/db/pg";
import { currentSession } from "@/server/web/http";

export const dynamic = "force-dynamic";

export default async function ManageReceipts({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const session = await currentSession();
  if (!session) redirect("/check");
  const raw = Number((await searchParams).page ?? 1);
  const page = Number.isSafeInteger(raw) && raw > 0 && raw <= 100_000 ? raw : 1;
  const db = getDb();
  const shop = (await db.query<{ kind: string }>("select kind from shops where id = $1", [session.shopId])).rows[0];
  if (!shop) redirect("/check");
  // No contact details leave this query. They are read only when the owner prepares a notice.
  const { rows } = await db.query<{ id: string; item: string; brand: string | null; model: string | null; created_at: Date }>(
    "select id, item, brand, model, created_at from safety_receipts where shop_id = $1 order by created_at desc, id limit 51 offset $2",
    [session.shopId, (page - 1) * 50],
  );
  return (
    <main className="page">
      <header className="page-head"><h1>Safety receipts</h1>{shop.kind === "DEMO" ? <span className="chip">DEMO SHOP</span> : null}</header>
      <p><a href="/queue">Back to queue</a></p>
      {rows.length === 0 ? <p>No receipts here.</p> : rows.slice(0, 50).map((r) => (
        <section className="window" key={r.id}>
          <div className="window-body">
            <h2>{[r.brand, r.item, r.model].filter(Boolean).join(" ")}</h2>
            <p>{new Date(r.created_at).toISOString().slice(0, 10)}</p>
            <details><summary>Delete receipt</summary>
              <form action={`/api/queue/safety-receipts/${r.id}/delete`} method="post"><button className="btn btn-outline">Delete this receipt and its notices</button></form>
            </details>
          </div>
        </section>
      ))}
      <nav className="actions" aria-label="Receipt pages">
        {page > 1 ? <a href={`?page=${page - 1}`}>Newer receipts</a> : null}
        {rows.length > 50 ? <a href={`?page=${page + 1}`}>Older receipts</a> : null}
      </nav>
    </main>
  );
}
