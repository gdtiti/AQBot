use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, DbErr, Statement};

use crate::error::{AQBotError, Result};

/// Register the sqlite-vec extension globally.
///
/// Must be called **once** before any SQLite connection is opened.
pub fn register_sqlite_vec_extension() {
    unsafe {
        libsqlite3_sys::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    }
}

/// A single embedding record for storage in the vector database.
#[derive(Debug, Clone)]
pub struct EmbeddingRecord {
    /// Unique chunk identifier
    pub id: String,
    /// Parent document identifier
    pub document_id: String,
    /// Position of this chunk within the document
    pub chunk_index: i32,
    /// Text content of the chunk
    pub content: String,
    /// Embedding vector
    pub embedding: Vec<f32>,
}

/// A result returned from vector similarity search.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VectorSearchResult {
    pub id: String,
    pub document_id: String,
    pub chunk_index: i32,
    pub content: String,
    /// Distance score (lower is more similar for L2 distance)
    pub score: f32,
}

/// sqlite-vec–backed vector store for knowledge base embeddings.
///
/// Each knowledge base gets two tables in the shared SQLite database:
/// - `vec_{id}_meta` — chunk metadata (id, document_id, content, …)
/// - `vec_{id}`      — vec0 virtual table holding the embedding vectors
pub struct VectorStore {
    db: DatabaseConnection,
}

impl VectorStore {
    /// Create a VectorStore that uses an existing sea-orm connection.
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db }
    }

    /// Sanitised table-name prefix for a collection.
    fn collection_name(collection_id: &str) -> String {
        format!("vec_{}", collection_id.replace('-', "_"))
    }

    /// Ensure both the metadata and vec0 tables exist for a collection.
    pub async fn ensure_collection(&self, collection_id: &str, dimensions: usize) -> Result<()> {
        let name = Self::collection_name(collection_id);

        self.exec(&format!(
            "CREATE TABLE IF NOT EXISTS {name}_meta (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                document_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL
            )"
        ))
        .await?;

        self.exec(&format!(
            "CREATE INDEX IF NOT EXISTS idx_{name}_doc ON {name}_meta(document_id)"
        ))
        .await?;

        self.exec(&format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS {name} USING vec0(embedding float[{dimensions}])"
        ))
        .await?;

        Ok(())
    }

    /// Upsert embedding records for a single document.
    ///
    /// All existing embeddings for the document (identified by `document_id` of
    /// the first record) are deleted before the new records are inserted.
    pub async fn upsert_embeddings(
        &self,
        collection_id: &str,
        records: Vec<EmbeddingRecord>,
    ) -> Result<()> {
        if records.is_empty() {
            return Ok(());
        }

        let dimensions = records[0].embedding.len();

        for (i, record) in records.iter().enumerate() {
            if record.embedding.len() != dimensions {
                return Err(AQBotError::Provider(format!(
                    "Embedding dimension mismatch at record {}: got {} but expected {}",
                    i,
                    record.embedding.len(),
                    dimensions
                )));
            }
        }

        self.ensure_collection(collection_id, dimensions).await?;

        let name = Self::collection_name(collection_id);
        let doc_id = &records[0].document_id;

        // Delete previous embeddings for this document.
        self.delete_rows_by_document(&name, doc_id).await?;

        // Insert new records.
        // IMPORTANT: Insert into vec0 FIRST (it auto-assigns its own rowid
        // and ignores explicit rowid values), then use that rowid for meta.
        for record in &records {
            let vec_json = Self::embedding_to_json(&record.embedding);

            // Step 1: Insert embedding into vec0 (without explicit rowid)
            self.db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    &format!("INSERT INTO {name} (embedding) VALUES ($1)"),
                    vec![vec_json.into()],
                ))
                .await
                .map_err(Self::wrap)?;

            // Step 2: Get the rowid that vec0 auto-assigned
            let last = self
                .db
                .query_one(Statement::from_string(
                    DbBackend::Sqlite,
                    "SELECT last_insert_rowid() AS rid",
                ))
                .await
                .map_err(Self::wrap)?
                .ok_or_else(|| AQBotError::Provider("last_insert_rowid failed".into()))?;

            let rowid: i64 = last.try_get("", "rid").map_err(Self::wrap)?;

            // Step 3: Insert meta with the same rowid from vec0
            self.db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    &format!(
                        "INSERT INTO {name}_meta (rowid, id, document_id, chunk_index, content) \
                         VALUES ($1, $2, $3, $4, $5)"
                    ),
                    vec![
                        rowid.into(),
                        record.id.clone().into(),
                        record.document_id.clone().into(),
                        record.chunk_index.into(),
                        record.content.clone().into(),
                    ],
                ))
                .await
                .map_err(Self::wrap)?;
        }

        Ok(())
    }

    /// Search for the most similar vectors in a knowledge base.
    ///
    /// Returns up to `top_k` results ordered by ascending distance.
    /// If the collection does not exist yet, an empty vec is returned.
    pub async fn search(
        &self,
        knowledge_base_id: &str,
        query_embedding: Vec<f32>,
        top_k: usize,
    ) -> Result<Vec<VectorSearchResult>> {
        let name = Self::collection_name(knowledge_base_id);

        if !self.table_exists(&format!("{name}_meta")).await? {
            tracing::warn!("Vector store: table {name}_meta does not exist, returning empty");
            return Ok(vec![]);
        }

        let vec_json = Self::embedding_to_json(&query_embedding);

        let sql = format!(
            "SELECT m.id, m.document_id, m.chunk_index, m.content, v.distance \
             FROM {name} v \
             JOIN {name}_meta m ON m.rowid = v.rowid \
             WHERE v.embedding MATCH $1 AND k = $2 \
             ORDER BY v.distance"
        );

        let rows = match self
            .db
            .query_all(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &sql,
                vec![vec_json.into(), (top_k as i64).into()],
            ))
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("Vector store: search query failed for {name}: {e}");
                return Ok(vec![]);
            }
        };

        let mut results = Vec::with_capacity(rows.len());
        for row in &rows {
            results.push(VectorSearchResult {
                id: row.try_get("", "id").map_err(Self::wrap)?,
                document_id: row.try_get("", "document_id").map_err(Self::wrap)?,
                chunk_index: row.try_get("", "chunk_index").map_err(Self::wrap)?,
                content: row.try_get("", "content").map_err(Self::wrap)?,
                score: row
                    .try_get::<f64>("", "distance")
                    .map(|v| v as f32)
                    .map_err(Self::wrap)?,
            });
        }

        Ok(results)
    }

    /// Delete all embeddings belonging to a specific document.
    pub async fn delete_document_embeddings(
        &self,
        knowledge_base_id: &str,
        document_id: &str,
    ) -> Result<()> {
        let name = Self::collection_name(knowledge_base_id);

        if !self.table_exists(&format!("{name}_meta")).await? {
            return Ok(());
        }

        self.delete_rows_by_document(&name, document_id).await
    }

    /// Drop both tables for a knowledge base.
    ///
    /// Silently succeeds if the tables do not exist.
    pub async fn delete_collection(&self, knowledge_base_id: &str) -> Result<()> {
        let name = Self::collection_name(knowledge_base_id);
        let _ = self.exec(&format!("DROP TABLE IF EXISTS {name}")).await;
        let _ = self
            .exec(&format!("DROP TABLE IF EXISTS {name}_meta"))
            .await;
        Ok(())
    }

    // ── private helpers ─────────────────────────────────────────────────

    /// Delete rows from both vec0 and metadata tables by `document_id`.
    async fn delete_rows_by_document(&self, table_name: &str, document_id: &str) -> Result<()> {
        let rows = self
            .db
            .query_all(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &format!("SELECT rowid FROM {table_name}_meta WHERE document_id = $1"),
                vec![document_id.to_string().into()],
            ))
            .await
            .map_err(Self::wrap)?;

        for row in &rows {
            let rid: i64 = row.try_get("", "rowid").map_err(Self::wrap)?;
            self.db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    &format!("DELETE FROM {table_name} WHERE rowid = $1"),
                    vec![rid.into()],
                ))
                .await
                .map_err(Self::wrap)?;
        }

        self.db
            .execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &format!("DELETE FROM {table_name}_meta WHERE document_id = $1"),
                vec![document_id.to_string().into()],
            ))
            .await
            .map_err(Self::wrap)?;

        Ok(())
    }

    /// Convert an embedding vector to a JSON array string for sqlite-vec.
    fn embedding_to_json(embedding: &[f32]) -> String {
        format!(
            "[{}]",
            embedding
                .iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join(",")
        )
    }

    /// Check whether a regular table exists in the database.
    async fn table_exists(&self, table_name: &str) -> Result<bool> {
        let row = self
            .db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "SELECT name FROM sqlite_master WHERE type='table' AND name=$1",
                vec![table_name.to_string().into()],
            ))
            .await
            .map_err(Self::wrap)?;
        Ok(row.is_some())
    }

    /// Shorthand for executing a statement with no parameters.
    async fn exec(&self, sql: &str) -> Result<()> {
        self.db
            .execute(Statement::from_string(DbBackend::Sqlite, sql))
            .await
            .map_err(Self::wrap)?;
        Ok(())
    }

    fn wrap(e: DbErr) -> AQBotError {
        AQBotError::Provider(format!("Vector store error: {e}"))
    }
}
