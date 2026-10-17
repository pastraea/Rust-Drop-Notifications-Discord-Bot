const Database = require("better-sqlite3");

async function main() {
    const database = new Database(process.argv[2], { readonly: true, fileMustExist: true });
    try {
        await database.backup(process.argv[3]);
    } finally {
        database.close();
    }
}

main().catch(() => {
    console.error("Database backup failed. The original database was not modified.");
    process.exitCode = 1;
});
