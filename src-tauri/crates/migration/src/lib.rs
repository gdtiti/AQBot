pub use sea_orm_migration::prelude::*;

mod m20240101_000001_init;
mod m20240102_000001_add_token_fields;
mod m20240103_000001_add_mcp_timeout_headers;
mod m20240104_000001_add_mcp_icon;
mod m20250105_000001_context_compression;
mod m20250106_000001_add_message_status;
mod m20250107_000001_add_provider_custom_headers;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20240101_000001_init::Migration),
            Box::new(m20240102_000001_add_token_fields::Migration),
            Box::new(m20240103_000001_add_mcp_timeout_headers::Migration),
            Box::new(m20240104_000001_add_mcp_icon::Migration),
            Box::new(m20250105_000001_context_compression::Migration),
            Box::new(m20250106_000001_add_message_status::Migration),
            Box::new(m20250107_000001_add_provider_custom_headers::Migration),
        ]
    }
}
