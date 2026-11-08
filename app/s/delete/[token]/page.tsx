import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DeleteReceiptPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ done?: string }> }) {
  const { token } = await params;
  if (!/^[\w-]{43}$/.test(token)) notFound();
  const done = (await searchParams).done === "1";
  return (
    <main className="page">
      <h1>Delete my data</h1>
      {done ? <p>This receipt has been deleted or was already gone.</p> : (
        <>
          <p>Bookmark this page. It lets you delete this receipt and its recall notices.</p>
          <form action={`/api/safety-receipts/delete/${token}`} method="post"><button className="btn" type="submit">Delete my safety receipt</button></form>
        </>
      )}
    </main>
  );
}
