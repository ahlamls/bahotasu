#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { initDatabase } from "../src/db/index.js";
import { UserModel, USER_ROLES } from "../src/models/index.js";
import { hashPassword } from "../src/lib/password.js";

const rl = createInterface({ input, output });

const ask = async (prompt, { hidden = false } = {}) => {
  if (!hidden) {
    const answer = await rl.question(prompt);
    return answer.trim();
  }
  return new Promise((resolve) => {
    const onData = (char) => {
      char = char + "";
      switch (char) {
        case "\n":
        case "\r":
        case "\u0004":
          output.write("\n");
          input.removeListener("data", onData);
          process.stdin.setRawMode(false);
          resolve(buffer);
          break;
        default:
          buffer += char;
          break;
      }
    };
    let buffer = "";
    process.stdin.setRawMode(true);
    input.on("data", onData);
    output.write(prompt);
  });
};

const validateEmail = (email) => /^\S+@\S+\.\S+$/.test(email);

const main = async () => {
  initDatabase();

  console.log("=== Bahotasu Superadmin Seeder ===");
  console.log("Please enter the Superadmin info that you wish to create");
  console.log("");

  const username = await ask("Username: ");
  if (!username) throw new Error("Username is required.");

  const email = await ask("Email: ");
  if (!validateEmail(email)) throw new Error("Email is invalid.");

  const name = await ask("Full name: ");
  if (!name) throw new Error("Name is required.");

  const password = await ask("Password: ", { hidden: true });
  if (!password || password.length < 6) {
    throw new Error("Password is required (min 6 chars).");
  }

  const passwordHash = hashPassword(password);

  try {
    const user = UserModel.create({
      username,
      email,
      name,
      passwordHash,
      role: USER_ROLES.SUPERADMIN,
    });
    console.log(`Superadmin created with ID ${user?.id}.`);
  } catch (error) {
    if (error.message.includes("UNIQUE")) {
      console.error("Error: username or email already exists.");
    } else {
      console.error("Failed to seed superadmin:", error);
    }
    process.exitCode = 1;
  } finally {
    rl.close();
  }
};

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
