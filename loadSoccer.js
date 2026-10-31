
const fs = require("fs");

const YEAR = 2026;
const MONTH = 9;

// How many notable soccer players to investigate
const CANDIDATE_LIMIT = 200;

// How many players to put in the final JSON
const OUTPUT_COUNT = 100;

// Number of simultaneous Wikipedia requests
const CONCURRENCY = 5;

const HEADERS = {
    "User-Agent": "WhoAmI/1.0 (Wikipedia player database)",
    "Accept": "application/json"
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJSON(url, headers = HEADERS) {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const response = await fetch(url, { headers });

            if (response.status === 404) return null;

            if (response.ok) return await response.json();

            if (response.status !== 429 && response.status < 500) {
                throw new Error(`HTTP ${response.status}: ${url}`);
            }
        } catch (error) {
            if (attempt === 4) throw error;
        }

        await sleep(1000 * (attempt + 1));
    }

    return null;
}

// 1. Get notable soccer players from Wikidata
async function getCandidates() {
    console.log("Fetching soccer player database...");

    const query = `
        SELECT DISTINCT
            ?item
            ?name
            ?description
            ?title
            ?sitelinks
        WHERE {
            ?item wdt:P106/wdt:P279* wd:Q937857.

            ?article schema:about ?item;
                     schema:isPartOf <https://en.wikipedia.org/>;
                     schema:name ?title.

            ?item wikibase:sitelinks ?sitelinks.

            ?item rdfs:label ?name.
            FILTER(LANG(?name) = "en")

            OPTIONAL {
                ?item schema:description ?description.
                FILTER(LANG(?description) = "en")
            }
        }
        ORDER BY DESC(?sitelinks)
        LIMIT ${CANDIDATE_LIMIT}
    `;

    const url = new URL("https://query.wikidata.org/sparql");
    url.searchParams.set("query", query);
    url.searchParams.set("format", "json");

    const data = await fetchJSON(url.toString(), {
        ...HEADERS,
        "Accept": "application/sparql-results+json"
    });

    if (!data) {
        throw new Error("Wikidata query failed.");
    }

    const candidates = data.results.bindings.map(person => ({
        title: person.title.value,
        wikidataId: person.item.value.split("/").pop(),
        name: person.name.value,
        description: person.description?.value || "",
        sitelinks: Number(person.sitelinks.value)
    }));

    console.log(`Found ${candidates.length} soccer players.`);

    return candidates;
}

// 2. Get monthly Wikipedia pageviews for one player
async function getPageviews(player) {
    const month = String(MONTH).padStart(2, "0");

    const lastDay = new Date(YEAR, MONTH, 0).getDate();

    const start = `${YEAR}${month}0100`;
    const end = `${YEAR}${month}${lastDay}00`;

    const title = encodeURIComponent(player.title.replace(/ /g, "_"));

    const url =
        `https://wikimedia.org/api/rest_v1/metrics/pageviews/` +
        `per-article/en.wikipedia.org/all-access/user/` +
        `${title}/monthly/${start}/${end}`;

    const data = await fetchJSON(url);

    if (!data || !data.items) return 0;

    return data.items.reduce(
        (total, item) => total + item.views,
        0
    );
}

// 3. Retrieve pageviews without overwhelming Wikimedia
async function rankPlayers(candidates) {
    const results = new Array(candidates.length);
    let completed = 0;

    async function worker() {
        while (true) {
            const index = completed++;

            if (index >= candidates.length) return;

            const player = candidates[index];

            try {
                const views = await getPageviews(player);

                results[index] = {
                    ...player,
                    views
                };
            } catch (error) {
                console.error(
                    `Failed: ${player.name} - ${error.message}`
                );

                results[index] = {
                    ...player,
                    views: 0
                };
            }

            if (completed % 50 === 0 ||
                completed >= candidates.length) {
                console.log(
                    `Checked ${Math.min(completed, candidates.length)}` +
                    `/${candidates.length} players`
                );
            }
        }
    }

    await Promise.all(
        Array.from({ length: CONCURRENCY }, () => worker())
    );

    return results;
}

// 4. Generate the final JSON
async function main() {
    console.log("Starting soccer player rankings...\n");

    const candidates = await getCandidates();

    const players = await rankPlayers(candidates);

    players.sort((a, b) => b.views - a.views);

    const ranked = players
        .filter(player => player.views > 0)
        .slice(0, OUTPUT_COUNT)
        .map((player, index) => ({
            title: player.title,
            wikidataId: player.wikidataId,
            name: player.name,
            description: player.description,
            rank: index + 1,
            views: player.views
        }));

    const output = {
        generatedAt: new Date().toISOString(),
        source: "English Wikipedia",
        period: {
            year: YEAR,
            month: String(MONTH).padStart(2, "0")
        },
        totalArticles: candidates.length,
        totalPeople: ranked.length,
        people: ranked
    };

    fs.writeFileSync(
        "people.json",
        JSON.stringify(output, null, 2)
    );

    console.log("\nFinished!");
    console.log(`Candidates: ${candidates.length}`);
    console.log(`Ranked players: ${ranked.length}`);
    console.log("Saved to people.json");
}

main().catch(console.error);
