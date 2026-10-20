// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     RolesFeature.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using UI.ManagementApi;

namespace UI.Components.Features.Roles;

/// <summary>
///   Registers the Roles feature.
/// </summary>
public static class RolesFeature
{
	/// <summary>
	///   Adds the Roles feature's handler, and the Management API seam it calls.
	/// </summary>
	/// <param name="services">The service collection to add to.</param>
	/// <returns>The same service collection, for chaining.</returns>
	public static IServiceCollection AddRolesFeature(this IServiceCollection services)
	{
		ArgumentNullException.ThrowIfNull(services);

		// AddManagementApi() registers each service once, so the Users slice can call it too.
		services.AddManagementApi();

		// The handler holds no state and the seam is a singleton, so one instance serves every circuit.
		services.AddSingleton<GetRolesOverviewHandler>();

		return services;
	}
}
