import { REST, Routes, SlashCommandBuilder, type Client } from "discord.js";
import { log } from "../log.ts";

/** Slash commands registered per allowed guild on ready. */
export const COMMANDS = [
  new SlashCommandBuilder().setName("help").setDescription("Справка по командам"),
  new SlashCommandBuilder()
    .setName("new")
    .setDescription("Новая сессия OpenCode и тема Discord")
    .addStringOption((option) => option.setName("title").setDescription("Название сессии").setMaxLength(100)),
  new SlashCommandBuilder().setName("sessions").setDescription("Последние сессии OpenCode"),
  new SlashCommandBuilder()
    .setName("attach")
    .setDescription("Подключить существующую сессию")
    .addStringOption((option) => option.setName("session").setDescription("sessionID или его начало").setRequired(true)),
  new SlashCommandBuilder().setName("detach").setDescription("Отвязать тему/канал от сессии"),
  new SlashCommandBuilder().setName("stop").setDescription("Прервать выполнение"),
  new SlashCommandBuilder().setName("status").setDescription("Состояние текущей сессии"),
  new SlashCommandBuilder()
    .setName("model")
    .setDescription("Модель сессии")
    .addStringOption((option) => option.setName("model").setDescription("providerID/modelID")),
  new SlashCommandBuilder()
    .setName("agent")
    .setDescription("Агент сессии")
    .addStringOption((option) => option.setName("agent").setDescription("id агента")),
  new SlashCommandBuilder().setName("fmt").setDescription("Проверка форматирования Discord"),
].map((command) => command.toJSON());

/** Registers commands in every allowed guild the bot is actually a member of. */
export async function registerCommands(client: Client, guildIds: string[]): Promise<void> {
  const applicationId = client.user?.id;
  if (!applicationId || !client.token) return;
  const rest = new REST({ version: "10" }).setToken(client.token);
  for (const guildId of guildIds) {
    if (!client.guilds.cache.has(guildId)) {
      log.warn(`discord: guild ${guildId} not found (bot invited?)`);
      continue;
    }
    try {
      await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: COMMANDS });
      log.info(`discord: slash commands registered in guild ${guildId}`);
    } catch (error) {
      // Slash commands are nice to have; messages and buttons still work.
      log.warn(`discord: command registration failed for guild ${guildId}: ${(error as Error).message}`);
    }
  }
}
