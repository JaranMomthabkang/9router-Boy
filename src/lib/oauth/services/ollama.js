/**
 * Ollama Cloud Service
 * Handles dynamic model discovery from Ollama Cloud API
 */

const OLLAMA_CLOUD_API = "https://ollama.com/api";

export class OllamaService {
  /**
   * List available models from Ollama Cloud
   * @param {string} accessToken - Ollama API key/token
   * @returns {Promise<Array>} - Array of model objects
   */
  async listAvailableModels(accessToken) {
    if (!accessToken) {
      throw new Error("Ollama API key is required");
    }

    try {
      const response = await fetch(`${OLLAMA_CLOUD_API}/tags`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error("Invalid or expired Ollama API key");
        }
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const data = await response.json();

      // Handle multiple response formats
      const models = data.models || data.results || [];

      return models.map((m) => this._normalizeModel(m)).filter(Boolean);
    } catch (error) {
      if (error.message === "Invalid or expired Ollama API key" || error.message.startsWith("HTTP ")) {
        throw error;
      }
      throw new Error(`Failed to list Ollama models: ${error.message}`);
    }
  }

  /**
   * Normalize model object to standard format
   * @private
   */
  _normalizeModel(model) {
    if (!model) return null;

    // Extract model ID - Ollama uses 'name' as the main identifier
    const id = model.name || model.id || model.model;
    if (!id) return null;

    return {
      id,
      name: model.display_name || model.displayName || model.name,
      description: model.description || "",
      // Ollama models include size and details
      size: model.size || 0,
      details: model.details || {},
      // Add context length if available (often in details)
      contextLength: model.contextLength || model.details?.context_length || 0,
      modified_at: model.modified_at,
    };
  }

  /**
   * Validate Ollama API key by attempting to list models
   * @param {string} apiKey - Ollama API key to validate
   * @returns {Promise<Object>} - Validation result
   */
  async validateApiKey(apiKey) {
    try {
      const models = await this.listAvailableModels(apiKey);
      return {
        valid: true,
        accessToken: apiKey,
        refreshToken: null, // Ollama uses static API keys, no refresh needed
        modelsCount: models.length,
      };
    } catch (error) {
      throw new Error(`Ollama API key validation failed: ${error.message}`);
    }
  }
}
