// Stable addresses for the phone builds, so a printed or filmed code keeps working if a build's link ever changes.
// A plain redirect: nothing is recorded, and nothing is added to the address.
const BUILDS = new Map([
  ["ios", "https://testflight.apple.com/join/2AGeG7KY"],
  ["android", "https://github.com/StephenSook/recall-reach/releases/download/android-1.0.0/recall-reach-android-1.0.0.apk"],
]);

export async function GET(_request: Request, { params }: { params: Promise<{ platform: string }> }): Promise<Response> {
  const target = BUILDS.get((await params).platform);
  if (!target) return new Response("Not found", { status: 404 });
  return new Response(null, { status: 302, headers: { location: target } });
}
