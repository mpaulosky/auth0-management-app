// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ManagementApiServiceCollectionExtensions.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using System.Threading.RateLimiting;

using Auth0.ManagementApi;

using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;

namespace UI.ManagementApi;

/// <summary>
///   Registers the Management API seam.
/// </summary>
public static class ManagementApiServiceCollectionExtensions
{
	/// <summary>
	///   Adds <see cref="IManagementApi" /> and everything behind it, each service once however many times this runs.
	/// </summary>
	/// <param name="services">The service collection to add to.</param>
	/// <returns>The same service collection, for chaining.</returns>
	public static IServiceCollection AddManagementApi(this IServiceCollection services)
	{
		ArgumentNullException.ThrowIfNull(services);

		// The options binding and the client's handler have no TryAdd form: run twice, they'd bind twice and stack a
		// second limiter handler on the client, so each request would take two tokens. The handler's own registration
		// marks that they're done.
		if (!services.Any(descriptor => descriptor.ServiceType == typeof(RateLimitingHandler)))
		{
			services.AddOptions<ManagementApiOptions>()
				.BindConfiguration(ManagementApiOptions.SectionName)
				.ValidateDataAnnotations()
				.ValidateOnStart();

			services.AddHttpClient(ManagementApiAdapter.HttpClientName)
				.AddHttpMessageHandler<RateLimitingHandler>();
		}

		services.TryAddTransient<RateLimitingHandler>();
		services.TryAddSingleton(TimeProvider.System);

		// A singleton RateLimiter, so a test can swap in one it replenishes by hand. It adds one token every
		// 1/PermitsPerSecond seconds, which spreads the refill evenly instead of in one lump each second.
		services.TryAddSingleton<RateLimiter>(provider =>
		{
			ManagementApiOptions options = provider.GetRequiredService<IOptions<ManagementApiOptions>>().Value;

			return new TokenBucketRateLimiter(new TokenBucketRateLimiterOptions
			{
				TokenLimit = options.Burst,
				TokensPerPeriod = 1,
				ReplenishmentPeriod = TimeSpan.FromSeconds(1.0 / options.PermitsPerSecond),
				AutoReplenishment = true,
				QueueLimit = 100,
				QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
			});
		});

		// The SDK's provider caches the token until shortly before it expires, so there's one for the app's lifetime.
		services.TryAddSingleton<ITokenProvider>(provider =>
		{
			ManagementApiOptions options = provider.GetRequiredService<IOptions<ManagementApiOptions>>().Value;
			HttpClient httpClient = provider.GetRequiredService<IHttpClientFactory>()
				.CreateClient(ManagementApiAdapter.HttpClientName);

			return new ClientCredentialsTokenProvider(options.Domain, options.ClientId, options.ClientSecret,
				httpClient: httpClient);
		});

		services.TryAddSingleton<IManagementApi, ManagementApiAdapter>();

		return services;
	}
}
