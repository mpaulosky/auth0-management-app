// ============================================
// Copyright (c) 2026. All rights reserved.
// File Name :     PublicApiExposureRule.cs
// Company :       mpaulosky
// Author :        Teqslamer
// Solution Name : Auth0ManagementApp
// Project Name :  Architecture.Tests
// =============================================

using System.Reflection;

namespace Architecture.Tests.Rules;

internal static class PublicApiExposureRule
{
	private const BindingFlags Declared =
		BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;

	public static IReadOnlyList<string> FindPublicTypes(Assembly assembly, string typeNamespace)
	{
		return [.. assembly.GetTypes()
			.Where(type => IsInNamespace(type, typeNamespace) && type.IsVisible)
			.Select(type => type.FullName ?? type.Name)
			.Order(StringComparer.Ordinal)];
	}

	/// <summary>
	///   Names the public types in <paramref name="typeNamespace" /> whose visible surface (base type, interfaces, fields,
	///   properties, events, and the return and parameter types of methods and constructors, down to generic arguments
	///   and array elements) mentions a type whose namespace starts with <paramref name="forbiddenNamespace" />.
	/// </summary>
	public static IReadOnlyList<string> FindTypesExposing(Assembly assembly, string typeNamespace, string forbiddenNamespace)
	{
		List<string> exposing = [];

		foreach (Type type in assembly.GetTypes().Where(type => IsInNamespace(type, typeNamespace) && type.IsVisible))
		{
			if (SurfaceTypes(type).Any(surface => IsForbidden(surface, forbiddenNamespace)))
			{
				exposing.Add(type.FullName ?? type.Name);
			}
		}

		return exposing;
	}

	private static bool IsInNamespace(Type type, string typeNamespace)
	{
		return type.Namespace is { } ns
			&& (ns.Equals(typeNamespace, StringComparison.Ordinal) || ns.StartsWith(typeNamespace + ".", StringComparison.Ordinal));
	}

	private static bool IsForbidden(Type type, string forbiddenNamespace)
	{
		return type.Namespace is { } ns
			&& (ns.Equals(forbiddenNamespace, StringComparison.Ordinal) || ns.StartsWith(forbiddenNamespace + ".", StringComparison.Ordinal));
	}

	private static IEnumerable<Type> SurfaceTypes(Type type)
	{
		List<Type> roots = [];

		if (type.BaseType is not null)
		{
			roots.Add(type.BaseType);
		}

		roots.AddRange(type.GetInterfaces());

		foreach (FieldInfo field in type.GetFields(Declared).Where(field => field.IsPublic || field.IsFamily || field.IsFamilyOrAssembly))
		{
			roots.Add(field.FieldType);
		}

		foreach (PropertyInfo property in type.GetProperties(Declared))
		{
			bool visible = (property.GetMethod?.IsPublic ?? false) || (property.GetMethod?.IsFamily ?? false)
				|| (property.SetMethod?.IsPublic ?? false) || (property.SetMethod?.IsFamily ?? false);

			if (visible)
			{
				roots.Add(property.PropertyType);
			}
		}

		foreach (MethodBase method in type.GetMethods(Declared).Cast<MethodBase>().Concat(type.GetConstructors(Declared))
			.Where(method => method.IsPublic || method.IsFamily || method.IsFamilyOrAssembly))
		{
			if (method is MethodInfo info)
			{
				roots.Add(info.ReturnType);
			}

			roots.AddRange(method.GetParameters().Select(parameter => parameter.ParameterType));
		}

		foreach (EventInfo declaredEvent in type.GetEvents(Declared))
		{
			if (declaredEvent.EventHandlerType is not null)
			{
				roots.Add(declaredEvent.EventHandlerType);
			}
		}

		return roots.SelectMany(Flatten);
	}

	private static IEnumerable<Type> Flatten(Type type)
	{
		yield return type;

		if (type.HasElementType && type.GetElementType() is { } element)
		{
			foreach (Type inner in Flatten(element))
			{
				yield return inner;
			}
		}

		if (type.IsGenericType)
		{
			foreach (Type argument in type.GetGenericArguments())
			{
				foreach (Type inner in Flatten(argument))
				{
					yield return inner;
				}
			}
		}
	}
}
