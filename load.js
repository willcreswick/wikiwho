
const fs = require("fs");
const path = require("path");

const PAGEVIEWS_API =
    "https://wikimedia.org/api/rest_v1/metrics/pageviews/top";

const WIKI_API =
    "https://en.wikipedia.org/w/api.php";

const WIKIDATA_API =
    "https://www.wikidata.org/w/api.php";

const ARTICLE_LISTS = {
    celebrities: {
        outputFile: "celebrities.json",
        matches: () => true
    },
    "soccer-athletes": {
        outputFile: "soccer-athletes.json",
        occupationIds: ["Q937857"],
        sportIds: ["Q2736"]
    },
    "football-athletes": {
        outputFile: "football-athletes.json",
        occupationIds: ["Q14128148"],
        sportIds: ["Q41323"]
    }
};

const BATCH_SIZE = 50;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJSON(url, retries = 6) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        const response = await fetch(url, {
            headers: {
                "User-Agent": "WhoAmIWordGame/1.0 (personal project)",
                "Accept": "application/json"
            }
        });

        if (response.ok) {
            return response.json();
        }

        if (response.status === 429 || response.status >= 500) {
            if (attempt === retries) {
                throw new Error(
                    `Request failed (${response.status}): ${url}`
                );
            }

            const retryAfter = Number(response.headers.get("Retry-After"));
            const delay = retryAfter
                ? retryAfter * 1000
                : Math.min(2000 * (2 ** attempt), 60000);

            console.log(
                `Rate limited. Retrying in ${delay / 1000}s...`
            );

            await sleep(delay);
            continue;
        }

        throw new Error(
            `Request failed (${response.status}): ${url}`
        );
    }
}

function normalizeTitle(title) {
    return title
        .replace(/_/g, " ")
        .trim()
        .toLowerCase();
}

// Get the previous completed month's top 1000 articles.
async function getTopViewedArticles() {
    const now = new Date();

    const date = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() - 1,
        1
    ));

    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");

    const url =
        `${PAGEVIEWS_API}/en.wikipedia.org/all-access/${year}/${month}/all-days`;

    console.log(`Fetching top articles for ${year}-${month}...`);

    const data = await fetchJSON(url);

    const articles = data.items?.[0]?.articles || [];

    return articles
        .filter(article =>
            article.article !== "Main_Page" &&
            !article.article.includes(":")
        )
        .map(article => ({
            title: article.article.replace(/_/g, " "),
            rank: article.rank,
            views: article.views
        }));
}

// Retrieve Wikidata IDs for all articles.
async function getPageWikidataIds(articles) {
    const results = [];

    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
        const batch = articles.slice(i, i + BATCH_SIZE);

        console.log(
            `Getting article IDs: ${Math.min(i + BATCH_SIZE, articles.length)}/${articles.length}`
        );

        const params = new URLSearchParams({
            action: "query",
            titles: batch.map(a => a.title).join("|"),
            prop: "pageprops",
            ppprop: "wikibase_item",
            redirects: "1",
            format: "json",
            formatversion: "2"
        });

        const data = await fetchJSON(
            `${WIKI_API}?${params}`
        );

        const requested = new Map(
            batch.map(article => [
                normalizeTitle(article.title),
                article
            ])
        );

        // Resolve normalized titles and redirects.
        const resolved = new Map();

        for (const item of data.query?.normalized || []) {
            const original = requested.get(
                normalizeTitle(item.from)
            );

            if (original) {
                resolved.set(
                    normalizeTitle(item.to),
                    original
                );
            }
        }

        for (const item of data.query?.redirects || []) {
            const original =
                requested.get(normalizeTitle(item.from)) ||
                resolved.get(normalizeTitle(item.from));

            if (original) {
                resolved.set(
                    normalizeTitle(item.to),
                    original
                );
            }
        }

        for (const page of data.query?.pages || []) {
            const qid = page.pageprops?.wikibase_item;

            if (!qid) continue;

            const original =
                requested.get(normalizeTitle(page.title)) ||
                resolved.get(normalizeTitle(page.title));

            if (!original) continue;

            results.push({
                ...original,
                title: page.title,
                wikidataId: qid
            });
        }
    }

    return results;
}

// Check whether a Wikidata entity represents a human.
function isPerson(entity) {
    const instances = entity?.claims?.P31 || [];

    return instances.some(claim =>
        claim.mainsnak?.datavalue?.value?.id === "Q5"
    );
}

function getClaimIds(entity, property) {
    return (entity?.claims?.[property] || [])
        .map(claim => claim.mainsnak?.datavalue?.value?.id)
        .filter(Boolean);
}

function matchesList(person, list) {
    if (list.matches) {
        return list.matches(person);
    }

    return list.occupationIds.some(id => person.occupationIds.includes(id)) ||
        list.sportIds.some(id => person.sportIds.includes(id));
}

// Filter articles to people and retain category fields for list generation.
async function getPeople(articles) {
    const pages = await getPageWikidataIds(articles);

    console.log(`Found ${pages.length} articles with Wikidata IDs.`);
    console.log("Checking which articles represent people...");

    const people = [];

    // Remove duplicate Wikidata IDs.
    const uniquePages = [
        ...new Map(
            pages.map(page => [page.wikidataId, page])
        ).values()
    ];

    for (let i = 0; i < uniquePages.length; i += BATCH_SIZE) {
        const batch = uniquePages.slice(i, i + BATCH_SIZE);

        const params = new URLSearchParams({
            action: "wbgetentities",
            ids: batch.map(p => p.wikidataId).join("|"),
            props: "claims|labels|descriptions",
            languages: "en",
            format: "json"
        });

        const data = await fetchJSON(
            `${WIKIDATA_API}?${params}`
        );

        for (const page of batch) {
            const entity = data.entities?.[page.wikidataId];

            if (!isPerson(entity)) continue;

            people.push({
                person: {
                    title: page.title,
                    wikidataId: page.wikidataId,
                    name: entity.labels?.en?.value || page.title,
                    description: entity.descriptions?.en?.value || "",
                    rank: page.rank,
                    views: page.views
                },
                occupationIds: getClaimIds(entity, "P106"),
                sportIds: getClaimIds(entity, "P641")
            });
        }
    }

    // Preserve pageview ranking.
    people.sort((a, b) => a.person.rank - b.person.rank);

    return people;
}

function getSelectedLists(args) {
    if (args.includes("--help") || args.includes("-h")) {
        console.log(
            "Usage: node data/load.js [celebrities|soccer-athletes|football-athletes|all]"
        );
        process.exit(0);
    }

    if (args.includes("all")) {
        if (args.length > 1) {
            throw new Error("Use 'all' by itself, or choose individual lists.");
        }

        return Object.keys(ARTICLE_LISTS);
    }

    const names = args.length > 0 ? args : ["celebrities"];
    const unknownLists = names.filter(name => !ARTICLE_LISTS[name]);

    if (unknownLists.length > 0) {
        throw new Error(
            `Unknown list "${unknownLists[0]}". Available lists: ` +
            `${Object.keys(ARTICLE_LISTS).join(", ")}, all`
        );
    }

    return [...new Set(names)];
}

function createDatabase(articles, people) {
    const now = new Date();
    const period = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() - 1,
        1
    ));

    return {
        generatedAt: now.toISOString(),
        source: "English Wikipedia",
        period: {
            year: period.getUTCFullYear(),
            month: String(period.getUTCMonth() + 1).padStart(2, "0")
        },
        totalArticles: articles.length,
        totalPeople: people.length,
        people
    };
}

// Generate one or more category-specific files from the most-viewed articles.
async function buildDatabases(listNames) {
    console.log(
        `Starting Wikipedia list generation: ${listNames.join(", ")}\n`
    );

    const articles = await getTopViewedArticles();
    console.log(`Retrieved ${articles.length} articles.\n`);

    const people = await getPeople(articles);
    console.log(`\nFound ${people.length} people.`);

    const outputs = listNames.map(name => {
        const list = ARTICLE_LISTS[name];
        const entries = people
            .filter(person => matchesList(person, list))
            .map(person => person.person);

        if (entries.length === 0) {
            throw new Error(`No people matched the "${name}" list.`);
        }

        return {
            name,
            file: path.join(__dirname, list.outputFile),
            database: createDatabase(articles, entries)
        };
    });

    for (const output of outputs) {
        fs.writeFileSync(
            output.file,
            JSON.stringify(output.database, null, 2),
            "utf8"
        );

        console.log(
            `Created ${output.file} with ${output.database.totalPeople} people.`
        );
    }
}

async function main() {
    try {
        const listNames = getSelectedLists(process.argv.slice(2));
        await buildDatabases(listNames);
    } catch (error) {
        console.error("\nList generation failed:");
        console.error(error.message);
        process.exitCode = 1;
    }
}

main();
