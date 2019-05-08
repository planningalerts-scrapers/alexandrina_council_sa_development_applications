// Parses the development application at the South Australian Alexandrina Council web site and
// places them in a database.
//
// Michael Bone
// 16th August 2018
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const cheerio = require("cheerio");
const request = require("request-promise-native");
const sqlite3 = require("sqlite3");
const urlparser = require("url");
const moment = require("moment");
const pdfjs = require("pdfjs-dist");
const fs = require("fs");
sqlite3.verbose();
const DevelopmentApplicationsUrl = "http://www.alexandrina.sa.gov.au/page.aspx?u=2351";
const CommentUrl = "mailto:alex@alexandrina.sa.gov.au";
// All valid suburb names.
let SuburbNames = null;
// Sets up an sqlite database.
async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let database = new sqlite3.Database("data.sqlite");
        database.serialize(() => {
            database.all("PRAGMA table_info('data')", (error, rows) => {
                if (rows.some(row => row.name === "on_notice_from"))
                    database.run("drop table [data]"); // ensure that the on_notice_from (and on_notice_to) columns are removed
                database.run("create table if not exists [data] ([council_reference] text primary key, [address] text, [description] text, [info_url] text, [comment_url] text, [date_scraped] text, [date_received] text)");
                resolve(database);
            });
        });
    });
}
// Inserts a row in the database if it does not already exist.
async function insertRow(database, developmentApplication) {
    return new Promise((resolve, reject) => {
        let sqlStatement = database.prepare("insert or replace into [data] values (?, ?, ?, ?, ?, ?, ?)");
        sqlStatement.run([
            developmentApplication.applicationNumber,
            developmentApplication.address,
            developmentApplication.description,
            developmentApplication.informationUrl,
            developmentApplication.commentUrl,
            developmentApplication.scrapeDate,
            developmentApplication.receivedDate
        ], function (error, row) {
            if (error) {
                console.error(error);
                reject(error);
            }
            else {
                console.log(`    Saved: application \"${developmentApplication.applicationNumber}\" with address \"${developmentApplication.address}\" and description \"${developmentApplication.description}\" into the database.`);
                sqlStatement.finalize(); // releases any locks
                resolve(row);
            }
        });
    });
}
// The direction to search for an adjacent element.
var Direction;
(function (Direction) {
    Direction[Direction["Right"] = 0] = "Right";
    Direction[Direction["Down"] = 1] = "Down";
})(Direction || (Direction = {}));
// Calculates the square of the Euclidean distance between two elements in the specified direction.
function calculateDistance(element1, element2, direction) {
    if (direction === Direction.Right) {
        let point1 = { x: element1.x + element1.width, y: element1.y + element1.height / 2 };
        let point2 = { x: element2.x, y: element2.y + element2.height / 2 };
        if (point2.x < point1.x - element1.width / 5) // arbitrary overlap factor of 20%
            return Number.MAX_VALUE;
        return (point2.x - point1.x) * (point2.x - point1.x) + (point2.y - point1.y) * (point2.y - point1.y);
    }
    else if (direction === Direction.Down) {
        let point1 = { x: element1.x + element1.width / 2, y: element1.y + element1.height };
        let point2 = { x: Math.min(element2.x + element1.width / 2, element2.x + element2.width), y: element2.y };
        if (point2.y < point1.y - element1.height / 2) // arbitrary overlap factor of 50%
            return Number.MAX_VALUE;
        return (point2.x - point1.x) * (point2.x - point1.x) + (point2.y - point1.y) * (point2.y - point1.y);
    }
    return Number.MAX_VALUE;
}
// Determines whether there is overlap between the two elements in the specified direction.
function isOverlap(element1, element2, direction) {
    if (direction === Direction.Right)
        return element2.y < element1.y + element1.height && element2.y + element2.height > element1.y;
    else if (direction === Direction.Down)
        return element2.x < element1.x + element1.width && element2.x + element2.width > element1.x;
    return false;
}
// Finds the closest element either right or down from the element with the specified text.
function findClosestElement(elements, text, direction) {
    text = text.toLowerCase();
    let matchingElement = elements.find(element => element.text.trim().toLowerCase().startsWith(text));
    if (matchingElement === undefined)
        return undefined;
    let closestElement = { text: undefined, x: Number.MAX_VALUE, y: Number.MAX_VALUE, width: 0, height: 0 };
    for (let element of elements)
        if (isOverlap(matchingElement, element, direction) && calculateDistance(matchingElement, element, direction) < calculateDistance(matchingElement, closestElement, direction))
            closestElement = element;
    return (closestElement.text === undefined) ? undefined : closestElement;
}
// Reads and parses development application details from the specified PDF.
async function parsePdf(url) {
    let developmentApplications = [];
    // Read the PDF.
    let buffer = await request({ url: url, proxy: process.env.MORPH_PROXY, encoding: null });
    await sleep(2000 + getRandom(0, 5) * 1000);
    // Parse the PDF.  Each page has details of a single application.
    const pdf = await pdfjs.getDocument({ data: buffer });
    for (let index = 0; index < pdf.numPages; index++) {
        let page = await pdf.getPage(index + 1);
        // Construct a text element for each item from the parsed PDF information.
        let textContent = await page.getTextContent();
        let viewport = await page.getViewport(1.0);
        let elements = textContent.items.map(item => {
            let transform = pdfjs.Util.transform(viewport.transform, item.transform);
            return { text: item.str, x: transform[4], y: transform[5], width: item.width, height: item.height };
        });
        // Find the application number, description, received date and address in the elements
        // (based on proximity to known text such as "Dev App No").
        let applicationNumberElement = findClosestElement(elements, "Application No", Direction.Right);
        let descriptionElement = findClosestElement(elements, "Development Description", Direction.Down);
        let receivedDateElement = findClosestElement(elements, "Application received", Direction.Right);
        let houseNumberElement = findClosestElement(elements, "Property House No", Direction.Right);
        let streetElement = findClosestElement(elements, "Property Street", Direction.Right);
        let suburbElement = findClosestElement(elements, "Property Suburb", Direction.Right);
        let address = "";
        if (houseNumberElement !== undefined)
            address += houseNumberElement.text.replace(/Ã¼/g, " ").replace(/ü/g, " ").replace(/\s\s+/g, " ").trim();
        if (streetElement !== undefined)
            address += ((address === "") ? "" : " ") + streetElement.text.replace(/Ã¼/g, " ").replace(/ü/g, " ").replace(/\s\s+/g, " ").trim();
        if (suburbElement === undefined || suburbElement.text.trim() === "" || suburbElement.text.trim() === "0") {
            let applicationNumber = (applicationNumberElement === undefined) ? "" : applicationNumberElement.text.trim();
            console.log(`Ignoring application ${applicationNumber} because there is no suburb.`);
            continue;
        }
        // Attempt to add the state and post code to the suburb.
        let suburbText = suburbElement.text.replace(/Ã¼/g, " ").replace(/ü/g, " ").replace(/\s\s+/g, " ").trim();
        let suburbName = SuburbNames[suburbText];
        if (suburbName === undefined) {
            for (let knownSuburbName in SuburbNames)
                if (knownSuburbName + " " + knownSuburbName === suburbText) {
                    suburbName = SuburbNames[knownSuburbName]; // adds the state and postcode
                    break;
                }
            if (suburbName === undefined)
                suburbName = suburbText; // fall back to whatever the original text was
        }
        address += ((address === "") ? "" : ", ") + suburbName;
        address = address.trim();
        // Ensure that the development application details are valid.
        if (applicationNumberElement === undefined || applicationNumberElement.text.trim() === "" || address === "") {
            console.log("Ignoring application because there is either no application number or no address.");
            continue;
        }
        let receivedDate = moment.invalid();
        if (receivedDateElement !== undefined)
            receivedDate = moment(receivedDateElement.text.trim(), "D/MM/YYYY", true); // allows the leading zero of the day to be omitted
        let description = "NO DESCRIPTION PROVIDED";
        if (descriptionElement !== null && descriptionElement.text.trim() !== "")
            description = descriptionElement.text.trim();
        let developmentApplication = {
            applicationNumber: applicationNumberElement.text.trim().replace(/\s/g, ""),
            address: address,
            description: description,
            informationUrl: url,
            commentUrl: CommentUrl,
            scrapeDate: moment().format("YYYY-MM-DD"),
            receivedDate: receivedDate.isValid() ? receivedDate.format("YYYY-MM-DD") : ""
        };
        developmentApplications.push(developmentApplication);
    }
    return developmentApplications;
}
// Gets a random integer in the specified range: [minimum, maximum).
function getRandom(minimum, maximum) {
    return Math.floor(Math.random() * (Math.floor(maximum) - Math.ceil(minimum))) + Math.ceil(minimum);
}
// Pauses for the specified number of milliseconds.
function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
// Parses the development applications.
async function main() {
    // Ensure that the database exists.
    let database = await initializeDatabase();
    // Read the files containing all possible suburb names.
    SuburbNames = {};
    for (let suburb of fs.readFileSync("suburbnames.txt").toString().replace(/\r/g, "").trim().split("\n"))
        SuburbNames[suburb.split(",")[0]] = suburb.split(",")[1];
    // Retrieve the page that contains the links to the PDFs.
    console.log(`Retrieving page: ${DevelopmentApplicationsUrl}`);
    let body = await request({ url: DevelopmentApplicationsUrl, proxy: process.env.MORPH_PROXY });
    let $ = cheerio.load(body);
    await sleep(2000 + getRandom(0, 5) * 1000);
    let pdfUrls = [];
    for (let element of $("td.u6ListTD a[href$='.pdf']").get()) {
        let pdfUrl = new urlparser.URL(element.attribs.href, DevelopmentApplicationsUrl).href;
        if (!pdfUrls.some(url => url === pdfUrl)) // avoid duplicates
            pdfUrls.push(pdfUrl);
    }
    if (pdfUrls.length === 0) {
        console.log("No PDF URLs were found on the page.");
        return;
    }
    // Select the most recent PDF.  And randomly select one other PDF (avoid processing all PDFs
    // at once because this may use too much memory, resulting in morph.io terminating the current
    // process).
    let selectedPdfUrls = [];
    selectedPdfUrls.push(pdfUrls.shift());
    if (pdfUrls.length > 0)
        selectedPdfUrls.push(pdfUrls[getRandom(1, pdfUrls.length)]);
    if (getRandom(0, 2) === 0)
        selectedPdfUrls.reverse();
    for (let pdfUrl of selectedPdfUrls) {
        console.log(`Parsing document: ${pdfUrl}`);
        let developmentApplications = await parsePdf(pdfUrl);
        console.log(`Parsed ${developmentApplications.length} development application(s) from document: ${pdfUrl}`);
        // Attempt to avoid reaching 512 MB memory usage (this will otherwise result in the
        // current process being terminated by morph.io).
        if (global.gc)
            global.gc();
        for (let developmentApplication of developmentApplications)
            await insertRow(database, developmentApplication);
    }
}
main().then(() => console.log("Complete.")).catch(error => console.error(error));
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NyYXBlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNjcmFwZXIudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsOEZBQThGO0FBQzlGLDZCQUE2QjtBQUM3QixFQUFFO0FBQ0YsZUFBZTtBQUNmLG1CQUFtQjtBQUVuQixZQUFZLENBQUM7O0FBRWIsbUNBQW1DO0FBQ25DLGtEQUFrRDtBQUNsRCxtQ0FBbUM7QUFDbkMsaUNBQWlDO0FBQ2pDLGlDQUFpQztBQUNqQyxvQ0FBb0M7QUFDcEMseUJBQXlCO0FBRXpCLE9BQU8sQ0FBQyxPQUFPLEVBQUUsQ0FBQztBQUVsQixNQUFNLDBCQUEwQixHQUFHLG1EQUFtRCxDQUFDO0FBQ3ZGLE1BQU0sVUFBVSxHQUFHLG1DQUFtQyxDQUFDO0FBSXZELDBCQUEwQjtBQUUxQixJQUFJLFdBQVcsR0FBRyxJQUFJLENBQUM7QUFFdkIsOEJBQThCO0FBRTlCLEtBQUs7SUFDRCxPQUFPLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLE1BQU0sRUFBRSxFQUFFO1FBQ25DLElBQUksUUFBUSxHQUFHLElBQUksT0FBTyxDQUFDLFFBQVEsQ0FBQyxhQUFhLENBQUMsQ0FBQztRQUNuRCxRQUFRLENBQUMsU0FBUyxDQUFDLEdBQUcsRUFBRTtZQUNwQixRQUFRLENBQUMsR0FBRyxDQUFDLDJCQUEyQixFQUFFLENBQUMsS0FBSyxFQUFFLElBQUksRUFBRSxFQUFFO2dCQUN0RCxJQUFJLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsSUFBSSxLQUFLLGdCQUFnQixDQUFDO29CQUMvQyxRQUFRLENBQUMsR0FBRyxDQUFDLG1CQUFtQixDQUFDLENBQUMsQ0FBRSx3RUFBd0U7Z0JBQ2hILFFBQVEsQ0FBQyxHQUFHLENBQUMsOExBQThMLENBQUMsQ0FBQztnQkFDN00sT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUFDO1lBQ3RCLENBQUMsQ0FBQyxDQUFDO1FBQ1AsQ0FBQyxDQUFD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