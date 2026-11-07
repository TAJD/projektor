import { customFieldOperations } from "../operations/custom-fields";
import { toMcpTool } from "../operations/define";

export const customFieldsTools = customFieldOperations.map(toMcpTool);
