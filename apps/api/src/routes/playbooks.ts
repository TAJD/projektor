import { operationsRouter } from "../operations/define";
import { playbookOperations } from "../operations/playbooks";

export const playbooksRouter = operationsRouter("/api/playbooks", playbookOperations);
