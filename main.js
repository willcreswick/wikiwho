
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKI_REST = "https://en.wikipedia.org/w/rest.php/v1/page";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const PAGEVIEWS_API = "https://wikimedia.org/api/rest_v1/metrics/pageviews/top";

const PEOPLE_LISTS = [
    {
        label: "Celebrities",
        source: "./data/celebrities.json"
    },/*
    {
        label: "Soccer Athletes",
        source: "./data/soccer-athletes.json"
    },
    {
        label: "Football Athletes",
        source: "./data/football-athletes.json"
    }*/
];

async function fetchJSON(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
    }

    return response.json();
}

// Get the top 1000 most-viewed articles from the previous month.
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

    const data = await fetchJSON(url);

    return data.items[0].articles
        .filter(article =>
            article.article !== "Main_Page" &&
            !article.article.includes(":")
        )
        .map(article => ({
            title: article.article.replace(/_/g, " "),
            views: article.views,
            rank: article.rank
        }));
}

// Normalize article titles for matching.
function normalizeTitle(title) {
    return title
        .replace(/_/g, " ")
        .trim()
        .toLowerCase();
}

// Retrieve Wikidata IDs for a batch of Wikipedia pages.
async function getPageWikidataIds(articles) {
    const results = [];

    for (let i = 0; i < articles.length; i += 50) {
        const batch = articles.slice(i, i + 50);

        const params = new URLSearchParams({
            action: "query",
            titles: batch.map(a => a.title).join("|"),
            prop: "pageprops",
            ppprop: "wikibase_item",
            redirects: "1",
            format: "json",
            formatversion: "2",
            origin: "*"
        });

        const data = await fetchJSON(`${WIKI_API}?${params}`);

        // Map original article titles to their pageview information.
        const articleMap = new Map(
            batch.map(article => [
                normalizeTitle(article.title),
                article
            ])
        );

        // Account for Wikipedia redirects.
        const redirectMap = new Map(
            (data.query?.redirects || []).map(redirect => [
                normalizeTitle(redirect.to),
                articleMap.get(normalizeTitle(redirect.from))
            ])
        );

        for (const page of data.query?.pages || []) {
            const qid = page.pageprops?.wikibase_item;

            if (!qid) continue;

            const original =
                articleMap.get(normalizeTitle(page.title)) ||
                redirectMap.get(normalizeTitle(page.title));

            if (!original) continue;

            results.push({
                ...original,
                title: page.title,
                pageprops: {
                    wikibase_item: qid
                }
            });
        }
    }

    return results;
}

// Get Wikidata information for an article.
async function getWikidata(qid) {
    const params = new URLSearchParams({
        action: "wbgetentities",
        ids: qid,
        props: "labels|aliases|claims",
        languages: "en",
        format: "json",
        origin: "*"
    });

    const data = await fetchJSON(`${WIKIDATA_API}?${params}`);

    return data.entities?.[qid];
}

// Verify that the Wikidata entity represents a human.
function isPerson(entity) {
    const instances = entity?.claims?.P31 || [];

    return instances.some(claim =>
        claim.mainsnak?.datavalue?.value?.id === "Q5"
    );
}

// Identify all people among the top 1000 articles.
async function getPopularPeople(articles) {
    const pages = await getPageWikidataIds(articles);

    const people = [];

    for (let i = 0; i < pages.length; i += 50) {
        const batch = pages.slice(i, i + 50);

        const params = new URLSearchParams({
            action: "wbgetentities",
            ids: batch.map(p => p.pageprops.wikibase_item).join("|"),
            props: "claims",
            format: "json",
            origin: "*"
        });

        const data = await fetchJSON(`${WIKIDATA_API}?${params}`);

        for (const page of batch) {
            const qid = page.pageprops.wikibase_item;
            const entity = data.entities?.[qid];

            if (isPerson(entity)) {
                people.push(page);
            }
        }
    }

    return people;
}

// Get all available English name variants.
function getNameVariants(title, entity, firstParagraph) {
    const names = new Set([title]);

    const label = entity?.labels?.en?.value;

    if (label) names.add(label);

    for (const alias of entity?.aliases?.en || []) {
        names.add(alias.value);
    }

    const boldName = firstParagraph.querySelector("b, strong");

    if (boldName) {
        const value = boldName.textContent.trim();

        if (value.length > 1) {
            names.add(value);
        }
    }

    // Include standalone first and last names in addition to full-name variants.
    const fullName = label || title;
    const nameParts = fullName.trim().split(/\s+/);

    if (nameParts.length > 1) {
        names.add(nameParts[0]);
        names.add(nameParts[nameParts.length - 1]);
    }

    return [...names]
        .filter(name => name && name.length > 1)
        .sort((a, b) => b.length - a.length);
}

// Redact all name variants, including standalone surnames.
function redactNames(text, names) {
    for (const name of names) {
        const escaped = name.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
        );

        const regex = new RegExp(
            `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
            "giu"
        );

        text = text.replace(regex, "[REDACTED]");
    }

    return text;
}

// Remove unwanted HTML elements and extract text.
function getCleanText(element) {
    const clone = element.cloneNode(true);

    clone.querySelectorAll(
        "sup, .reference, .mw-ref, style, script"
    ).forEach(el => el.remove());

    return clone.textContent
        .replace(/\s+/g, " ")
        .trim();
}

// Split text into individual sentences.
function splitSentences(text) {
    if (typeof Intl.Segmenter !== "undefined") {
        const segmenter = new Intl.Segmenter("en", {
            granularity: "sentence"
        });

        return [...segmenter.segment(text)]
            .map(item => item.segment.trim())
            .filter(sentence => sentence.length > 25);
    }

    return text.match(/[^.!?]+[.!?]+["')\]]*/g)
        ?.map(sentence => sentence.trim())
        .filter(sentence => sentence.length > 25) || [];
}

// Get the three longest sentences.
function getSentences(sentences, rand, longest) {
    let all = sentences
        .sort((a, b) => b.length - a.length);

    let top = all.slice(0, longest);

    all = all.slice(longest);

    for (let i = 0; i < rand; i++) {
        if (all.length === 0) break;

        const index = Math.floor(Math.random() * all.length);
        
        top.push(all[index]);
        all.splice(index, 1);
    }

    return top.sort((a, b) => a.length - b.length);
}

// Extract the entire infobox as readable text.
function getInfoboxText(doc) {
    const infobox = doc.querySelector("table.infobox");

    if (!infobox) return null;

    const clone = infobox.cloneNode(true);

    clone.querySelectorAll(
        "sup, .reference, .mw-ref, style, script"
    ).forEach(el => el.remove());

    const rows = [...clone.querySelectorAll("tr")];

    const result = rows.map(row => {
        const cells = [...row.children].filter(
            cell => ["TH", "TD"].includes(cell.tagName)
        );

        if (cells.length === 0) return null;

        const label = cells[0].innerText.trim();

        const value = cells
            .slice(1)
            .map(cell => cell.innerText.trim())
            .filter(Boolean)
            .join(" ");

        if (cells.length === 1) {
            return label || null;
        }

        return label
            ? `${label}: ${value}`
            : value;
    }).filter(Boolean);

    return result.join("\n");
}

// Fetch and process an individual article.
async function processArticle(maxPar, page) {
    const qid = page.pageprops?.wikibase_item;

    if (!qid) return null;

    // Verify that this is a person.
    const entity = await getWikidata(qid);

    if (!isPerson(entity)) return null;

    // Get the complete rendered article.
    const url =
        `${WIKI_REST}/${encodeURIComponent(page.title)}/html`;

    const response = await fetch(url);

    if (!response.ok) return null;

    const html = await response.text();

    const doc = new DOMParser().parseFromString(
        html,
        "text/html"
    );

    // Get article paragraphs, excluding infoboxes and navigation.
    const paragraphs = [...doc.querySelectorAll("p")]
        .filter(p => !p.closest(
            "table, .navbox, .metadata, .reflist"
        ))
        .map(p => ({
            element: p,
            text: getCleanText(p)
        }))
        .filter(p => p.text.length > 0);

    if (paragraphs.length < maxPar) return null;

    const firstParagraph = paragraphs[0];

    const names = getNameVariants(
        page.title,
        entity,
        firstParagraph.element
    );

    // Get sentences from every paragraph except the first.
    const availableSentences = paragraphs
        .slice(1)
        .flatMap(p => splitSentences(p.text));

    if (availableSentences.length < 3) return null;

    const selectedSentences = getSentences(
        availableSentences,
        2, 2
    );

    // Get the first sentence of the introduction.
    const introduction = splitSentences(
        firstParagraph.text
    )[0];

    if (!introduction) return null;

    // Extract the infobox.
    const infobox = getInfoboxText(doc);

    if (!infobox) return null;

    // Build the clue list.
    const clues = [
        ...selectedSentences.map(sentence => ({
            type: "paragraph",
            text: redactNames(sentence, names)
        })),
        {
            type: "introduction",
            text: redactNames(introduction, names)
        }
    ];

    return {
        title: page.title,
        wikidataId: qid,
        views: page.views,
        rank: page.rank,
        clues
    };
}

const peopleCache = new Map();

async function loadPeople(list) {
    if (!list) {
        throw new Error("Choose a people list.");
    }

    if (peopleCache.has(list)) {
        return peopleCache.get(list);
    }

    const response = await fetch(list);

    if (!response.ok) {
        throw new Error(`Failed to load ${list}: ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data.people) || data.people.length === 0) {
        throw new Error(`No people found in ${list}.`);
    }

    peopleCache.set(list, data.people);
    return data.people;
}

// Find a random person and generate clues from Wikipedia.

async function getRandomPersonClues(list, par, maxAttempts = 100) {
    const people = [...await loadPeople(list)];

    // Randomize the candidates.
    for (let i = people.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [people[i], people[j]] = [people[j], people[i]];
    }

    // Try generating clues until a valid person is found.
    const attempts = Math.min(maxAttempts, people.length);

    for (let i = 0; i < attempts; i++) {
        const person = people[i];

        // Reconstruct the page object expected by processArticle().
        const page = {
            title: person.title,
            views: person.views,
            rank: person.rank,
            pageprops: {
                wikibase_item: person.wikidataId
            }
        };

        try {
            // Fetch Wikidata and Wikipedia, then generate the clues.
            const result = await processArticle(par, page);

            if (result) {
                return result;
            }
        } catch (error) {
            console.warn(`Skipping ${person.title}:`, error.message);
        }
    }

    throw new Error(
        `Could not generate clues after ${attempts} attempts.`
    );
}

const startScreen = document.querySelector("#start-screen");
const startStatus = document.querySelector("#start-status");
const startButton = document.querySelector("#start-button");
const gameScreen = document.querySelector("#game-screen");
const gameStatus = document.querySelector("#game-status");
const clueCount = document.querySelector("#clue-count");
const clueText = document.querySelector("#clue-text");
const clueHistory = document.querySelector("#clue-history");
const clueHistoryList = document.querySelector("#clue-history-list");
const guessForm = document.querySelector("#guess-form");
const guessInput = document.querySelector("#guess-input");
const peopleOptions = document.querySelector("#people-options");
const guessButton = document.querySelector("#guess-button");
const feedback = document.querySelector("#feedback");
const skipButton = document.querySelector("#skip-button");
const nextPersonButton = document.querySelector("#next-person-button");
const listSelect = document.querySelector("#list-select");

let currentPerson = null;
let currentClueIndex = 0;
let activeList = null;

function setGuessingEnabled(enabled) {
    guessInput.disabled = !enabled;
    guessButton.disabled = !enabled;
    skipButton.disabled = !enabled;
}

function finishRound(message) {
    clueCount.textContent = "";
    const answer = currentPerson.title
        .replace(/\s*\([^)]*\)/g, "")
        .replace(/\s+/g, " ")
        .trim();
    clueText.textContent = `The person was ${answer}.`;
    feedback.textContent = message;
    guessForm.hidden = true;
    skipButton.hidden = true;
    nextPersonButton.hidden = false;
    nextPersonButton.textContent = "Next person";
}

function renderClueContent(element, text) {
    element.replaceChildren();
    const parts = text.split("[REDACTED]");

    for (const [index, part] of parts.entries()) {
        if (part) {
            element.append(document.createTextNode(part));
        }

        if (index < parts.length - 1) {
            const redacted = document.createElement("span");
            redacted.className = "redacted";
            redacted.textContent = "REDACTED";
            redacted.setAttribute("aria-label", "redacted name");
            element.append(redacted);
        }
    }
}

function showCurrentClue() {
    const clue = currentPerson.clues[currentClueIndex];
    clueCount.textContent =
        `Clue ${currentClueIndex + 1} of ${currentPerson.clues.length}`;
    renderClueContent(clueText, clue.text);
}

function addPreviousClue(clue) {
    const item = document.createElement("li");
    renderClueContent(item, clue.text);
    clueHistoryList.append(item);
    clueHistory.hidden = false;
    clueHistory.open = true;
    clueHistory.querySelector("summary").textContent =
        `Previous clues (${clueHistoryList.children.length})`;
}

async function loadNextPerson(list, isStarting = false) {
    currentPerson = null;
    setGuessingEnabled(false);
    guessForm.hidden = false;
    skipButton.hidden = false;
    nextPersonButton.hidden = true;
    nextPersonButton.textContent = "Next person";
    guessInput.value = "";
    feedback.textContent = "";
    clueHistory.hidden = true;
    clueHistory.open = false;
    clueHistoryList.replaceChildren();
    clueHistory.querySelector("summary").textContent = "Previous clues";
    clueCount.textContent = "";
    clueText.textContent = "Getting your next person...";
    if (isStarting) {
        startButton.disabled = true;
        startStatus.textContent = "Loading the selected list and first clue...";
    } else {
        gameStatus.textContent = "Loading a person...";
    }
    nextPersonButton.disabled = true;

    try {
        const people = await loadPeople(list);
        peopleOptions.replaceChildren();

        for (const person of people) {
            const option = document.createElement("option");
            option.value = person.title;
            peopleOptions.append(option);
        }

        currentPerson = await getRandomPersonClues(list, 10);
        currentClueIndex = 0;
        if (isStarting) {
            startScreen.hidden = true;
            gameScreen.hidden = false;
        }
        gameStatus.textContent = "Make a guess or skip to the next clue.";
        setGuessingEnabled(true);
        showCurrentClue();
        nextPersonButton.disabled = false;
        guessInput.focus();
    } catch (error) {
        if (isStarting) {
            startStatus.textContent = `Could not start the game: ${error.message}`;
            startButton.disabled = false;
        } else {
            gameStatus.textContent = `Could not load a person: ${error.message}`;
            clueText.textContent = "Please try again.";
            nextPersonButton.textContent = "Try again";
            nextPersonButton.hidden = false;
            nextPersonButton.disabled = false;
        }
    }
}

guessForm.addEventListener("submit", event => {
    event.preventDefault();

    if (!currentPerson) {
        return;
    }

    const guess = normalizeTitle(guessInput.value).replace(/\s+/g, " ");
    const answer = normalizeTitle(currentPerson.title).replace(/\s+/g, " ");

    if (guess === answer) {
        gameStatus.textContent = "Correct!";
        finishRound("You got it!");
        return;
    }

    feedback.textContent = "Not quite. Try another guess or skip this clue.";
    guessInput.select();
});

skipButton.addEventListener("click", () => {
    if (!currentPerson) {
        return;
    }

    addPreviousClue(currentPerson.clues[currentClueIndex]);
    currentClueIndex += 1;

    if (currentClueIndex >= currentPerson.clues.length) {
        gameStatus.textContent = "You used all the clues.";
        finishRound("Better luck on the next person!");
        return;
    }

    feedback.textContent = "";
    showCurrentClue();
});

for (const list of PEOPLE_LISTS) {
    const option = document.createElement("option");
    option.value = list.source;
    option.textContent = list.label;
    listSelect.append(option);
}

startButton.addEventListener("click", () => {
    activeList = listSelect.value;
    loadNextPerson(activeList, true);
});

nextPersonButton.addEventListener("click", () => {
    loadNextPerson(activeList);
});