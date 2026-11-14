// The largest US metro areas (about 100, by the Census Bureau's 2020s estimates), each with its
// main towns and its state's code, for the "Where do you want to work?" box: picking one fills in
// the towns a role's place may name. Compiled by hand from public knowledge, 2026-11-12. A town
// another place shares a name with (Aurora, IL; Dublin, Ireland; Portland, ME) is left out of the
// metro it is smaller in, or written with its state ("Columbia, SC").
// One line a metro: name | state code | towns separated by ";", the main one first.
const LIST = `
New York|NY|New York; NYC; Manhattan; Brooklyn; Queens; Bronx; Staten Island; Long Island City; Jersey City; Hoboken; Newark; White Plains; Yonkers
Los Angeles|CA|Los Angeles; Santa Monica; Culver City; Pasadena; Burbank; Long Beach; Irvine; Anaheim; Santa Ana; Costa Mesa; Torrance; El Segundo; Playa Vista; Newport Beach
Chicago|IL|Chicago; Evanston; Naperville; Schaumburg; Oak Brook; Deerfield; Northbrook; Skokie; Rosemont; Downers Grove; Lombard
Dallas–Fort Worth|TX|Dallas; Fort Worth; Plano; Irving; Frisco; Richardson; Addison; Denton; McKinney; Carrollton; Grapevine; Allen; Las Colinas; Southlake; Westlake
Houston|TX|Houston; The Woodlands; Sugar Land; Katy; Pearland; Conroe; Baytown
Washington, DC|DC|Washington, DC; Washington DC; Washington, D.C.; Arlington; Alexandria; Reston; Herndon; McLean; Tysons; Fairfax; Bethesda; Rockville; Silver Spring; Chantilly; Falls Church; Gaithersburg; Ashburn; Sterling; Leesburg
Philadelphia|PA|Philadelphia; King of Prussia; Conshohocken; Camden; Cherry Hill; Malvern; Wayne; Radnor; Plymouth Meeting; Bala Cynwyd
Miami|FL|Miami; Fort Lauderdale; Boca Raton; West Palm Beach; Miami Beach; Coral Gables; Doral; Pompano Beach; Sunrise; Plantation; Aventura; Delray Beach; Jupiter
Atlanta|GA|Atlanta; Alpharetta; Marietta; Sandy Springs; Norcross; Kennesaw; Peachtree Corners; Buckhead
Boston|MA|Boston; Cambridge; Somerville; Waltham; Woburn; Newton; Quincy; Needham; Bedford; Watertown; Framingham; Natick; Brookline; Lowell; Andover; Wellesley
Phoenix|AZ|Phoenix; Scottsdale; Tempe; Mesa; Chandler; Gilbert; Goodyear
San Francisco Bay Area|CA|San Francisco; SF; Bay Area; Oakland; Berkeley; Emeryville; San Jose; Palo Alto; Mountain View; Menlo Park; Sunnyvale; Santa Clara; Cupertino; Redwood City; San Mateo; Foster City; South San Francisco; Burlingame; San Carlos; Los Gatos; Milpitas; Fremont; Pleasanton; Livermore; Walnut Creek; San Ramon; Hayward; San Bruno; Campbell
Riverside–San Bernardino|CA|Riverside; San Bernardino; Temecula; Corona; Rancho Cucamonga; Murrieta; Moreno Valley; Fontana; Palm Springs
Detroit|MI|Detroit; Southfield; Dearborn; Auburn Hills; Farmington Hills; Novi; Livonia; Royal Oak; Sterling Heights
Seattle|WA|Seattle; Bellevue; Redmond; Kirkland; Tacoma; Everett; Bothell; Renton; Issaquah; Lynnwood; Woodinville; Tukwila
Minneapolis–St. Paul|MN|Minneapolis; St. Paul; Saint Paul; Eden Prairie; Edina; Minnetonka; Eagan; Maple Grove; Golden Valley
San Diego|CA|San Diego; La Jolla; Carlsbad; Chula Vista; Oceanside; Escondido; Sorrento Valley; Del Mar; Poway; Encinitas
Tampa|FL|Tampa; St. Petersburg; Clearwater; Brandon; Largo; Wesley Chapel
Denver|CO|Denver; Boulder; Aurora; Lakewood; Englewood; Greenwood Village; Littleton; Broomfield; Westminster; Golden; Centennial; Arvada; Thornton; Longmont; Lone Tree; Highlands Ranch
Baltimore|MD|Baltimore; Towson; Annapolis; Hunt Valley; Owings Mills; Linthicum; Ellicott City; Glen Burnie; Fort Meade
St. Louis|MO|St. Louis; Saint Louis; Clayton; Chesterfield; St. Charles; Creve Coeur; Maryland Heights
Orlando|FL|Orlando; Lake Mary; Kissimmee; Sanford; Winter Park; Altamonte Springs; Maitland; Lake Buena Vista
Charlotte|NC|Charlotte; Gastonia; Rock Hill; Huntersville; Mooresville; Fort Mill; Matthews
San Antonio|TX|San Antonio; New Braunfels; Schertz; Boerne
Portland|OR|Portland; Beaverton; Hillsboro; Vancouver, WA; Lake Oswego; Tigard; Gresham; Wilsonville; Tualatin
Sacramento|CA|Sacramento; Roseville; Folsom; Rancho Cordova; Davis; Elk Grove; El Dorado Hills
Pittsburgh|PA|Pittsburgh; Cranberry Township; Canonsburg; Monroeville
Austin|TX|Austin; Round Rock; Cedar Park; Pflugerville; San Marcos; Leander; Kyle
Las Vegas|NV|Las Vegas; Henderson; North Las Vegas; Summerlin
Cincinnati|OH|Cincinnati; Mason; Blue Ash; West Chester; Covington
Kansas City|MO|Kansas City; Overland Park; Olathe; Lenexa; Lee's Summit; Leawood
Columbus|OH|Columbus; Westerville; New Albany; Worthington; Hilliard; Grove City
Indianapolis|IN|Indianapolis; Fishers; Noblesville; Greenwood; Zionsville
Cleveland|OH|Cleveland; Beachwood; Mayfield Heights; Westlake; Strongsville; Solon
Nashville|TN|Nashville; Franklin; Brentwood; Murfreesboro; Hendersonville
Virginia Beach–Norfolk|VA|Virginia Beach; Norfolk; Chesapeake; Newport News; Hampton
Providence|RI|Providence; Cranston; Pawtucket; East Providence; Woonsocket; Fall River
Jacksonville|FL|Jacksonville; Ponte Vedra; Orange Park; Fernandina Beach; St. Augustine
Milwaukee|WI|Milwaukee; Waukesha; Brookfield; Wauwatosa; West Allis; Menomonee Falls; Pewaukee
Raleigh–Durham|NC|Raleigh; Durham; Cary; Chapel Hill; Research Triangle Park; RTP; Morrisville; Apex; Wake Forest
Oklahoma City|OK|Oklahoma City; Edmond; Norman; Moore
Memphis|TN|Memphis; Germantown; Collierville; Southaven; Bartlett
Richmond|VA|Richmond; Glen Allen; Henrico; Midlothian; Short Pump
Louisville|KY|Louisville; Jeffersonville
New Orleans|LA|New Orleans; Metairie; Kenner
Salt Lake City|UT|Salt Lake City; SLC; West Valley City; Sandy; Draper; South Jordan; Lehi; Murray; Midvale; Cottonwood Heights
Provo–Orem|UT|Provo; Orem; Lehi; American Fork; Pleasant Grove; Lindon; Vineyard
Hartford|CT|Hartford; West Hartford; East Hartford; New Britain; Glastonbury; Farmington; Rocky Hill
Buffalo|NY|Buffalo; Cheektowaga; Niagara Falls; Tonawanda; Williamsville
Birmingham|AL|Birmingham; Hoover; Vestavia Hills; Homewood
Rochester|NY|Rochester; Pittsford; Henrietta; Webster; Fairport
Grand Rapids|MI|Grand Rapids; Kentwood; Grandville
Tucson|AZ|Tucson; Oro Valley; Marana
Honolulu|HI|Honolulu; Pearl City; Kapolei; Kailua
Tulsa|OK|Tulsa; Broken Arrow; Owasso; Jenks
Fresno|CA|Fresno; Clovis
Worcester|MA|Worcester; Marlborough; Westborough
Omaha|NE|Omaha; Council Bluffs; Papillion; La Vista
Bridgeport–Stamford|CT|Stamford; Norwalk; Bridgeport; Danbury; Westport; Fairfield; Shelton; Darien
Greenville|SC|Greenville; Spartanburg; Greer; Mauldin; Simpsonville
Albuquerque|NM|Albuquerque; Rio Rancho
Bakersfield|CA|Bakersfield
Albany|NY|Albany; Schenectady; Troy; Saratoga Springs; Clifton Park; Latham; Colonie
Knoxville|TN|Knoxville; Oak Ridge; Maryville
El Paso|TX|El Paso
Baton Rouge|LA|Baton Rouge
McAllen|TX|McAllen; Edinburg; Mission; Pharr
New Haven|CT|New Haven; Milford; Hamden; West Haven; Wallingford; Branford
Allentown|PA|Allentown; Bethlehem; Easton
Oxnard–Thousand Oaks|CA|Oxnard; Thousand Oaks; Ventura; Camarillo; Simi Valley; Westlake Village
Columbia|SC|Columbia, SC; Columbia, South Carolina; West Columbia; Irmo
Sarasota|FL|Sarasota; Bradenton; North Port; Lakewood Ranch
Dayton|OH|Dayton; Kettering; Beavercreek; Fairborn; Miamisburg; Centerville
Charleston|SC|Charleston, SC; Charleston, South Carolina; North Charleston; Mount Pleasant; Summerville; Daniel Island
Greensboro|NC|Greensboro; High Point
Stockton|CA|Stockton; Lodi; Tracy; Manteca
Cape Coral–Fort Myers|FL|Cape Coral; Fort Myers; Bonita Springs; Estero
Boise|ID|Boise; Nampa
Colorado Springs|CO|Colorado Springs; Monument
Little Rock|AR|Little Rock; North Little Rock
Lakeland|FL|Lakeland; Winter Haven
Akron|OH|Akron; Cuyahoga Falls; Stow
Des Moines|IA|Des Moines; West Des Moines; Ankeny; Urbandale; Clive
Springfield|MA|Springfield, MA; Springfield, Massachusetts; Chicopee; Holyoke
Ogden|UT|Ogden; Layton; Clearfield; Bountiful
Madison|WI|Madison, WI; Madison, Wisconsin; Middleton; Fitchburg; Sun Prairie
Winston-Salem|NC|Winston-Salem
Daytona Beach|FL|Daytona Beach; Deltona; Ormond Beach; Port Orange
Syracuse|NY|Syracuse
Toledo|OH|Toledo; Perrysburg; Maumee; Sylvania
Wichita|KS|Wichita
Augusta|GA|Augusta; Evans
Palm Bay–Melbourne|FL|Melbourne, FL; Melbourne, Florida; Palm Bay; Titusville; Cocoa Beach
Harrisburg|PA|Harrisburg; Mechanicsburg; Camp Hill; Hershey
Spokane|WA|Spokane; Spokane Valley; Liberty Lake
Jackson|MS|Jackson, MS; Jackson, Mississippi; Ridgeland; Flowood
Chattanooga|TN|Chattanooga
Scranton|PA|Scranton; Wilkes-Barre
Lancaster|PA|Lancaster, PA; Lancaster, Pennsylvania
Huntsville|AL|Huntsville
Portland, Maine|ME|Portland, ME; Portland, Maine; South Portland; Westbrook
Lexington|KY|Lexington, KY; Lexington, Kentucky
Reno|NV|Reno; Sparks
Ann Arbor|MI|Ann Arbor; Ypsilanti
Northwest Arkansas|AR|Fayetteville, AR; Bentonville; Rogers; Springdale
Pensacola|FL|Pensacola
`;

export type Metro = { name: string; state: string; towns: string[] };

export const METROS: Metro[] = LIST.trim()
  .split("\n")
  .map((line) => {
    const [name, state, towns] = line.split("|") as [string, string, string];
    return { name, state, towns: towns.split(";").map((t) => t.trim()) };
  });

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[–—.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Metros typed text may mean, best first: one whose name, then one whose town, starts with it. */
export function suggest(text: string, n = 6): Metro[] {
  const q = norm(text);
  if (q.length < 2) return [];
  const starts = (s: string) => norm(s).startsWith(q) || norm(s).includes(` ${q}`);
  const byName = METROS.filter((m) => starts(m.name));
  const byTown = METROS.filter((m) => !byName.includes(m) && m.towns.some(starts));
  return [...byName, ...byTown].slice(0, n);
}

/**
 * What a picked metro keeps: its towns, and "<main town>, <state>" when no town says its state.
 * That line is how the profile's places are known to be American (ats/filters.ts profileStates),
 * without the state's code on its own, which would let in every role in the state (Los Angeles for
 * the Bay Area).
 */
export function wordsOf(m: Metro): string[] {
  const coded = m.towns.some((t) => new RegExp(`,\\s*${m.state}$`).test(t));
  return coded ? [...m.towns] : [...m.towns, `${m.towns[0]}, ${m.state}`];
}

/** A kept word that only says the state ("Denver, CO" beside "Denver"): its state, else null. */
export function stateMark(word: string, words: string[]): string | null {
  const m = word.match(/^(.+),\s*([A-Z]{2})$/);
  return m && words.some((w) => w.toLowerCase() === m[1]!.toLowerCase()) ? m[2]! : null;
}
