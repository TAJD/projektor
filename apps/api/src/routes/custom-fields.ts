import { customFieldOperations } from "../operations/custom-fields";
import { operationsRouter } from "../operations/define";

export const customFieldsRouter = operationsRouter("/api/custom-fields", customFieldOperations);
