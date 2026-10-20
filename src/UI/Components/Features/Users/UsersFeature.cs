// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     UsersFeature.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

using FluentValidation;

using UI.ManagementApi;

namespace UI.Components.Features.Users;

/// <summary>
///   Registers the Users feature: its validator and handler, and the Management API seam they call.
/// </summary>
public static class UsersFeature
{
	/// <summary>
	///   Adds the Users feature, and the Management API seam through <c>AddManagementApi()</c>.
	/// </summary>
	/// <param name="services">The service collection to add to.</param>
	/// <returns>The same service collection, for chaining.</returns>
	public static IServiceCollection AddUsersFeature(this IServiceCollection services)
	{
		ArgumentNullException.ThrowIfNull(services);

		services.AddManagementApi();

		// Neither holds state, and the seam they call is a singleton, so one instance serves every circuit.
		services.AddSingleton<IValidator<SearchUsersQuery>, SearchUsersQueryValidator>();
		services.AddSingleton<SearchUsersHandler>();

		return services;
	}
}
