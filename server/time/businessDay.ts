// CPSC's dates are US dates with no time of day, and this app's shops are US shops. So every day a seller
// sees, and every comparison with a recall date, uses one US calendar. Elapsed time, such as the 180-day
// refund window and leases, is measured from exact moments and does not depend on this.
const BUSINESS_TIME_ZONE = "America/New_York";

const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** That moment's calendar day in the business time zone, YYYY-MM-DD. */
export const businessDay = (at: Date = new Date()): string => formatter.format(at);

/** The same zone, for SQL. */
export const BUSINESS_TIME_ZONE_SQL = `'${BUSINESS_TIME_ZONE}'`;
