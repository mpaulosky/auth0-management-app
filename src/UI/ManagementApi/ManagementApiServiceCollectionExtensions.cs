// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     ManagementApiServiceCollectionExtensions.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  UI
// =============================================

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
		throw new NotImplementedException();
	}
}
