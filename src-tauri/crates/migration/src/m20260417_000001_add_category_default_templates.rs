use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ConversationCategories::Table)
                    .add_column(
                        ColumnDef::new(ConversationCategories::DefaultProviderId)
                            .string()
                            .null(),
                    )
                    .add_column(
                        ColumnDef::new(ConversationCategories::DefaultModelId)
                            .string()
                            .null(),
                    )
                    .add_column(
                        ColumnDef::new(ConversationCategories::DefaultTemperature)
                            .double()
                            .null(),
                    )
                    .add_column(
                        ColumnDef::new(ConversationCategories::DefaultMaxTokens)
                            .big_integer()
                            .null(),
                    )
                    .add_column(
                        ColumnDef::new(ConversationCategories::DefaultTopP)
                            .double()
                            .null(),
                    )
                    .add_column(
                        ColumnDef::new(ConversationCategories::DefaultFrequencyPenalty)
                            .double()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(ConversationCategories::Table)
                    .drop_column(ConversationCategories::DefaultFrequencyPenalty)
                    .drop_column(ConversationCategories::DefaultTopP)
                    .drop_column(ConversationCategories::DefaultMaxTokens)
                    .drop_column(ConversationCategories::DefaultTemperature)
                    .drop_column(ConversationCategories::DefaultModelId)
                    .drop_column(ConversationCategories::DefaultProviderId)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }
}

#[derive(DeriveIden)]
enum ConversationCategories {
    Table,
    DefaultProviderId,
    DefaultModelId,
    DefaultTemperature,
    DefaultMaxTokens,
    DefaultTopP,
    DefaultFrequencyPenalty,
}
